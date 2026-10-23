import { describe, expect, it } from "vitest";
import { detailsFingerprint, verifyTrustAccount, type TrustAccountInput, type VerificationPorts } from "../src/domain/trust-verification";

const input: TrustAccountInput = {
  id: "t1", firmId: "f1", tier: "registered", jurisdiction: "QLD",
  accountName: "Smith Legal Trust Account", bsb: "064-000", accountNumber: "1234 5678"
};

function ports(over: Partial<{ cert: boolean; nameCheck: boolean | null; emailOk: boolean; letter: boolean; callback: boolean; fail: boolean }> = {}): VerificationPorts {
  const o = { cert: true, nameCheck: true, emailOk: true, letter: true, callback: false, fail: false, ...over };
  return {
    registry: { lookup: async () => { if (o.fail) throw new Error("registry timeout"); return { practisingCertificateCurrent: o.cert, registryEmail: "firm@example.com" }; } },
    email: { isConfirmed: async () => o.emailOk, sendVerification: async () => {} },
    nameCheck: { check: async () => o.nameCheck },
    documents: { hasBankLetter: async () => o.letter },
    callbacks: { isCompleted: async () => o.callback }
  };
}

describe("verifyTrustAccount", () => {
  it("auto-approves a registered firm whose details are unchanged", async () => {
    const fp = await detailsFingerprint(input.accountName, input.bsb, input.accountNumber);
    const r = await verifyTrustAccount({ ...input, lastHumanApprovedFingerprint: fp }, ports());
    expect(r.decision.kind).toBe("approved");
    expect(r.openAdminCase).toBe(false);
  });
  it("flags for an admin when an automated check fails to run", async () => {
    const r = await verifyTrustAccount(input, ports({ fail: true }));
    expect(r.decision.kind).toBe("flagged_for_admin");
    expect(r.openAdminCase).toBe(true);
  });
  it("rejects a name mismatch and opens an admin case", async () => {
    const r = await verifyTrustAccount(input, ports({ nameCheck: false }));
    expect(r.decision.kind).toBe("rejected");
    expect(r.openAdminCase).toBe(true);
  });
  it("sends a new or unregistered firm to a person once all checks pass", async () => {
    const r = await verifyTrustAccount({ ...input, tier: "unregistered" }, ports());
    expect(r.decision.kind).toBe("awaiting_human_approval");
    expect(r.openAdminCase).toBe(true);
  });
  it("changes the fingerprint when any detail changes and ignores formatting", async () => {
    const a = await detailsFingerprint("A Trust", "064-000", "1234 5678");
    expect(await detailsFingerprint("a trust ", "064000", "12345678")).toBe(a);
    expect(await detailsFingerprint("A Trust", "064-000", "1234 5679")).not.toBe(a);
  });
});
