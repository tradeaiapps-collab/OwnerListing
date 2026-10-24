import { describe, expect, it } from "vitest";
import { validateAbn, verifyBusinessBuyer, type BusinessBuyerClaim } from "../src/domain/abn";
import { abrLookupFromEnv, createAbrLookup, parseAbrReply } from "../src/adapters/abr-lookup";

const GUID = "abcd1234-SECRET-guid-0000";
const claim: BusinessBuyerClaim = { abn: "51 824 753 556", declaredEntityName: "Example Pty Ltd", authorityDocumentReviewed: true };
const ok = (body: string) => async () => ({ ok: true, text: async () => body });
const good = 'callback({"Abn":"51824753556","AbnStatus":"Active","EntityName":"EXAMPLE PTY LTD","Gst":"2012-01-01","Message":""})';

describe("validateAbn", () => {
  it("accepts the ATO example with or without spaces", () => {
    expect(validateAbn("51 824 753 556")).toEqual({ ok: true, abn: "51824753556" });
    expect(validateAbn(" 51824753556 ")).toEqual({ ok: true, abn: "51824753556" });
  });
  it.each([
    ["51 824 753 557", /not valid/], ["5182475355", /exactly 11/], ["518247535561", /exactly 11/],
    ["5182475355A", /digits only/], ["abcdefghijk", /digits only/], ["00000000000", /not valid/], ["", /Enter an ABN/], ["   ", /Enter an ABN/]
  ])("rejects %j", (v, re) => {
    const r = validateAbn(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
  it("rejects non-strings", () => {
    expect(validateAbn(51824753556).ok).toBe(false);
    expect(validateAbn(null).ok).toBe(false);
  });
});

describe("ABR adapter", () => {
  it("sends a fixed-host, no-redirect, timed request", async () => {
    let seen: { url: string; init: { redirect: string; signal: AbortSignal } } | undefined;
    const p = createAbrLookup(GUID, async (url, init) => { seen = { url, init }; return { ok: true, text: async () => good }; });
    const r = await p.lookup("51 824 753 556");
    const u = new URL(seen!.url);
    expect(u.origin + u.pathname).toBe("https://abr.business.gov.au/json/AbnDetails.aspx");
    expect(u.searchParams.get("abn")).toBe("51824753556");
    expect(u.searchParams.get("callback")).toBe("callback");
    expect(u.searchParams.get("guid")).toBe(GUID);
    expect(seen!.init.redirect).toBe("error");
    expect(seen!.init.signal).toBeInstanceOf(AbortSignal);
    expect(r).toEqual({ abn: "51824753556", active: true, entityName: "EXAMPLE PTY LTD", gstRegistered: true });
  });
  it("reads no GST as false", async () => {
    const p = createAbrLookup(GUID, ok('callback({"Abn":"51824753556","AbnStatus":"Active","EntityName":"X","Gst":null,"Message":""})'));
    expect((await p.lookup("51824753556"))?.gstRegistered).toBe(false);
  });
  it("does not call the register for an invalid ABN", async () => {
    let called = false;
    const p = createAbrLookup(GUID, async () => { called = true; return { ok: true, text: async () => good }; });
    expect(await p.lookup("51824753557")).toBeNull();
    expect(called).toBe(false);
  });
  it.each([
    "", "not jsonp", "alert(1)", "callback(", "callback({bad json})", "callback([1,2])", "callback(null)", "callback(1);alert(1)",
    'evil({"Abn":"51824753556"})', 'callback({"Abn":"11111111111","AbnStatus":"Active","EntityName":"X"})',
    'callback({"Message":"Invalid GUID ' + GUID + '"})', "callback(" + "x".repeat(70_000) + ")"
  ])("treats a malformed or hostile reply as an error: %#", async body => {
    await expect(createAbrLookup(GUID, ok(body)).lookup("51824753556")).rejects.toThrow(/ABN register/);
  });
  it("ignores wrong field types", () => {
    const r = parseAbrReply('callback({"Abn":"51824753556","AbnStatus":5,"EntityName":{"a":1},"Gst":7,"Message":null})', "51824753556");
    expect(r).toEqual({ abn: "51824753556", active: false, entityName: "", gstRegistered: undefined });
  });
  it("never puts the GUID in errors", async () => {
    const failures = [
      async () => { throw new Error(`fetch failed https://x/?guid=${GUID}`); },
      async () => ({ ok: false, text: async () => GUID }),
      ok(`callback({"Message":"bad ${GUID}"})`), ok(`junk ${GUID}`)
    ];
    for (const f of failures) {
      const e = await createAbrLookup(GUID, f).lookup("51824753556").then(() => null, (x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect(String(e!.message)).not.toContain(GUID);
      expect(JSON.stringify(e)).not.toContain(GUID);
    }
  });
  it("is unconfigured without ABN_LOOKUP_GUID", () => {
    expect(abrLookupFromEnv({})).toBeNull();
    expect(abrLookupFromEnv({ ABN_LOOKUP_GUID: "  " })).toBeNull();
    expect(abrLookupFromEnv({ ABN_LOOKUP_GUID: GUID }, ok(good))).not.toBeNull();
  });
});

describe("business buyer without ABR confirmation", () => {
  it("records format valid, not confirmed, and never approves", async () => {
    const r = await verifyBusinessBuyer(claim, true, null);
    expect(r.ok).toBe(false);
    expect(r.abnStatus).toBe("format_valid_not_confirmed");
    expect(r.problems.join(" ")).toMatch(/not confirmed with ABR/);
  });
  it("invalid ABN is rejected before any lookup", async () => {
    const r = await verifyBusinessBuyer({ ...claim, abn: "5182475355" }, true, null);
    expect(r.abnStatus).toBe("invalid");
  });
  it("sends name or GST mismatch to staff review once configured", async () => {
    const port = createAbrLookup(GUID, ok(good));
    expect((await verifyBusinessBuyer({ ...claim, declaredEntityName: "Other Pty Ltd" }, true, port)).abnStatus).toBe("needs_review");
    const g = await verifyBusinessBuyer({ ...claim, declaredGstRegistered: false }, true, port);
    expect(g.abnStatus).toBe("needs_review");
    expect(g.ok).toBe(false);
    expect((await verifyBusinessBuyer({ ...claim, declaredGstRegistered: true }, true, port)).ok).toBe(true);
  });
  it("register outage stays not confirmed", async () => {
    const port = createAbrLookup(GUID, async () => { throw new Error("down"); });
    const r = await verifyBusinessBuyer(claim, true, port);
    expect(r.abnStatus).toBe("format_valid_not_confirmed");
    expect(r.ok).toBe(false);
  });
});
