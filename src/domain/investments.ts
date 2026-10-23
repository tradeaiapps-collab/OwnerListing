/**
 * Playbook Gate G4: investment module must not launch until all G4 release
 * conditions and written legal approvals are satisfied.
 */
export interface InvestmentLaunchControls {
  featureFlagEnabled: boolean;
  legalPathwayApproved: boolean;
  escrowProviderContracted: boolean;
  endToEndNoPlatformCustodyTestPassed: boolean;
  investorEligibilityLive: boolean;
  issuerReviewProcessLive: boolean;
  eSignatureEvidenceTestPassed: boolean;
}

export function canLaunchInvestmentModule(c: InvestmentLaunchControls): boolean {
  return Object.values(c).every(Boolean);
}

export function assertInvestmentModuleDisabled(flag: string | undefined): void {
  if (flag !== "true") return;
  throw new Error(
    "Investment module launch is blocked by default. Enabling requires documented Gate G4 approval and verified controls."
  );
}
