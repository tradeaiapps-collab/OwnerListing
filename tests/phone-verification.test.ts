import { describe, expect, it } from "vitest";
import {
  confirmPhoneVerification, createInMemoryPhoneRepository, parseAuMobile, startPhoneVerification,
  MAX_ATTEMPTS, MAX_SENDS_PER_HOUR, type PhoneDeps
} from "../src/domain/phone-verification";
import { hashCodeWith } from "../src/server/phone-db";

const actor = { userId: "u1", userType: "owner" as const };

function setup(opts: { sms?: boolean } = {}) {
  const sent: { to: string; text: string }[] = [];
  let clock = Date.parse("2026-10-23T00:00:00Z");
  let n = 0;
  const phones = createInMemoryPhoneRepository();
  const deps: PhoneDeps = {
    phones,
    sms: opts.sms === false ? undefined : { async send(to, text) { sent.push({ to, text }); } },
    hashCode: hashCodeWith("test-secret-test-secret-test-secret"),
    newCode: () => "123456",
    appendAudit: async () => {},
    now: () => new Date(clock).toISOString(),
    newId: () => `id-${++n}`
  };
  return { deps, sent, phones, advance: (min: number) => { clock += min * 60_000; } };
}

describe("parseAuMobile", () => {
  it("accepts common Australian mobile formats", () => {
    expect(parseAuMobile("0412 345 678")).toBe("+61412345678");
    expect(parseAuMobile("+61 412 345 678")).toBe("+61412345678");
    expect(parseAuMobile("61412345678")).toBe("+61412345678");
  });
  it("rejects landlines, short numbers and non strings", () => {
    expect(parseAuMobile("0712345678")).toBeNull();
    expect(parseAuMobile("041234567")).toBeNull();
    expect(parseAuMobile(412345678)).toBeNull();
  });
});

describe("phone verification", () => {
  it("is blocked when no SMS provider is configured", async () => {
    const { deps } = setup({ sms: false });
    const r = await startPhoneVerification(deps, actor, "0412345678");
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("sends a code and verifies with the right code", async () => {
    const { deps, sent, phones } = setup();
    expect((await startPhoneVerification(deps, actor, "0412345678")).ok).toBe(true);
    expect(sent[0]?.to).toBe("+61412345678");
    expect(sent[0]?.text).toContain("123456");
    expect((await confirmPhoneVerification(deps, actor, "123456")).ok).toBe(true);
    expect(phones.verified.get("u1")).toBe("+61412345678");
  });

  it("rejects a wrong code and does not verify", async () => {
    const { deps, phones } = setup();
    await startPhoneVerification(deps, actor, "0412345678");
    expect(await confirmPhoneVerification(deps, actor, "000000")).toMatchObject({ ok: false, code: "invalid" });
    expect(phones.verified.size).toBe(0);
  });

  it("locks after too many wrong attempts, even for the right code", async () => {
    const { deps } = setup();
    await startPhoneVerification(deps, actor, "0412345678");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await confirmPhoneVerification(deps, actor, "000000");
    expect(await confirmPhoneVerification(deps, actor, "123456")).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("rejects an expired code", async () => {
    const { deps, advance } = setup();
    await startPhoneVerification(deps, actor, "0412345678");
    advance(11);
    expect(await confirmPhoneVerification(deps, actor, "123456")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("does not accept the same code twice", async () => {
    const { deps } = setup();
    await startPhoneVerification(deps, actor, "0412345678");
    await confirmPhoneVerification(deps, actor, "123456");
    expect((await confirmPhoneVerification(deps, actor, "123456")).ok).toBe(false);
  });

  it("limits sends per hour per user and per phone", async () => {
    const { deps } = setup();
    for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) expect((await startPhoneVerification(deps, actor, "0412345678")).ok).toBe(true);
    expect(await startPhoneVerification(deps, actor, "0412345678")).toMatchObject({ ok: false, code: "rate_limited" });
    // A different account cannot flood the same number either.
    expect(await startPhoneVerification(deps, { userId: "u2", userType: "owner" }, "0412345678")).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("refuses a number already verified on another account", async () => {
    const { deps, phones } = setup();
    await phones.markVerified("u1", "+61412345678", "x");
    const other = { userId: "u2", userType: "owner" as const };
    await startPhoneVerification(deps, other, "0412345678");
    expect(await confirmPhoneVerification(deps, other, "123456")).toMatchObject({ ok: false, code: "conflict" });
    expect(phones.verified.get("u2")).toBeUndefined();
  });
});
