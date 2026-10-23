import { describe, expect, it } from "vitest";
import { decideTrustAccount, type TrustAccountEvidence } from "../src/domain/trust-account";

const good: TrustAccountEvidence = {
  practisingCertificateCurrent: true, firmEmailVerified: true,
  accountNameMatches: true, bankLetterOnFile: true, callbackCompleted: false
};

describe("decideTrustAccount", () => {
  it("auto-approves a registered firm with unchanged, previously approved details", () => {
    expect(decideTrustAccount("registered", good, "fp1", "fp1").kind).toBe("approved");
  });
  it("needs a person for changed details or an unregistered firm", () => {
    expect(decideTrustAccount("registered", good, "fp2", "fp1").kind).toBe("awaiting_human_approval");
    expect(decideTrustAccount("unregistered", good, "fp1", "fp1").kind).toBe("awaiting_human_approval");
  });
  it("rejects an expired certificate or a name mismatch", () => {
    expect(decideTrustAccount("registered", { ...good, practisingCertificateCurrent: false }, "fp1", "fp1").kind).toBe("rejected");
    expect(decideTrustAccount("registered", { ...good, accountNameMatches: false }, "fp1", "fp1").kind).toBe("rejected");
  });
  it("flags for an admin when automation fails", () => {
    const d = decideTrustAccount("registered", { ...good, automationError: "registry timeout" }, "fp1", "fp1");
    expect(d.kind).toBe("flagged_for_admin");
  });
  it("requires a call-back only when the name check is unavailable", () => {
    const e = { ...good, accountNameMatches: null };
    expect(decideTrustAccount("unregistered", e, "fp1").kind).toBe("needs_more_evidence");
    expect(decideTrustAccount("unregistered", { ...e, callbackCompleted: true }, "fp1").kind).toBe("awaiting_human_approval");
  });
});
