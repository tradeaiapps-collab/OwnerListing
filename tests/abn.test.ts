import { describe, expect, it } from "vitest";
import { isValidAbnChecksum, normaliseAbn, verifyBusinessBuyer, type AbnLookupPort, type BusinessBuyerClaim } from "../src/domain/abn";

const claim: BusinessBuyerClaim = { abn: "51 824 753 556", declaredEntityName: "Example Holdings Pty Ltd", authorityDocumentReviewed: true };
const port = (rec: { abn: string; active: boolean; entityName: string } | null | "throw"): AbnLookupPort => ({
  lookup: async () => { if (rec === "throw") throw new Error("down"); return rec; }
});

describe("ABN", () => {
  it("checks the official checksum", () => {
    expect(normaliseAbn("51 824 753 556")).toBe("51824753556");
    expect(isValidAbnChecksum("51 824 753 556")).toBe(true);
    expect(isValidAbnChecksum("51 824 753 557")).toBe(false);
    expect(isValidAbnChecksum("123")).toBe(false);
  });
  it("accepts an active, matching business with proof of authority and an ID-verified person", async () => {
    const r = await verifyBusinessBuyer(claim, true, port({ abn: "51824753556", active: true, entityName: "EXAMPLE HOLDINGS PTY LTD" }));
    expect(r).toEqual({ ok: true, problems: [], abnStatus: "confirmed" });
  });
  it("lists every problem, and hands over to an admin if the register is down", async () => {
    const bad = await verifyBusinessBuyer({ ...claim, authorityDocumentReviewed: false }, false,
      port({ abn: "51824753556", active: false, entityName: "Someone Else Pty Ltd" }));
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBe(4);
    const down = await verifyBusinessBuyer(claim, true, port("throw"));
    expect(down.problems[0]).toMatch(/not confirmed with ABR/);
    expect((await verifyBusinessBuyer({ ...claim, abn: "11111111111" }, true, port(null))).problems).toEqual(["The ABN is not valid."]);
  });
});
