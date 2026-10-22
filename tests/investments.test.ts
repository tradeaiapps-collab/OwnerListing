import { describe, expect, it } from "vitest";
import { canLaunchInvestmentModule, assertInvestmentModuleDisabled } from "../src/domain/investments";

describe("investment Gate G4", () => {
  it("blocks launch unless every control is true", () => {
    expect(canLaunchInvestmentModule({
      featureFlagEnabled: true,
      legalPathwayApproved: true,
      escrowProviderContracted: true,
      endToEndNoPlatformCustodyTestPassed: true,
      investorEligibilityLive: true,
      issuerReviewProcessLive: true,
      eSignatureEvidenceTestPassed: false
    })).toBe(false);
  });

  it("keeps module disabled unless explicitly configured", () => {
    expect(() => assertInvestmentModuleDisabled("false")).not.toThrow();
    expect(() => assertInvestmentModuleDisabled("true")).toThrow(/Gate G4/);
  });
});
