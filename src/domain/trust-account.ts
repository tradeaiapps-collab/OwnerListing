export type FirmTier = "registered" | "unregistered";

/** Results of the automated checks for one job. Gathered by the verification service, never typed in by users. */
export interface TrustAccountEvidence {
  /** Practising certificate is current on the state regulator's register. */
  practisingCertificateCurrent: boolean;
  /** Firm clicked a verification link sent to the email listed on the regulator's register. */
  firmEmailVerified: boolean;
  /** Account name check result. null means the bank does not support it. */
  accountNameMatches: boolean | null;
  /** Bank letter or statement header showing a trust account is on file. */
  bankLetterOnFile: boolean;
  /** Staff phoned the firm on its registered number. Only needed when the name check is unavailable. */
  callbackCompleted: boolean;
  /** Set when an automated check failed to run (registry down, timeout, unreadable result). */
  automationError?: string;
}

export type TrustAccountDecision =
  | { kind: "approved"; reasons: string[] }
  | { kind: "awaiting_human_approval"; reasons: string[] }
  | { kind: "needs_more_evidence"; reasons: string[] }
  | { kind: "flagged_for_admin"; reasons: string[] }
  | { kind: "rejected"; reasons: string[] };

/**
 * Decides whether a trust account may be used for a job.
 * - Registered firm, details unchanged since a person last approved them, and checks still pass: auto-approved.
 * - New firm, new or changed details: all automated checks must pass, then a person approves.
 * - A failed practising certificate or a name mismatch is rejected outright.
 */
export function decideTrustAccount(
  tier: FirmTier,
  evidence: TrustAccountEvidence,
  detailsFingerprint: string,
  lastHumanApprovedFingerprint?: string
): TrustAccountDecision {
  // If automation could not run, nothing else can be trusted: an admin takes over the case.
  if (evidence.automationError) {
    return { kind: "flagged_for_admin", reasons: [`Automated verification failed: ${evidence.automationError}. Admin to verify manually.`] };
  }
  if (!evidence.practisingCertificateCurrent) {
    return { kind: "rejected", reasons: ["Practising certificate is not current."] };
  }
  if (evidence.accountNameMatches === false) {
    return { kind: "rejected", reasons: ["Account name does not match the firm's trust account. Possible fraud; escalate."] };
  }

  const unchanged = lastHumanApprovedFingerprint !== undefined && lastHumanApprovedFingerprint === detailsFingerprint;
  if (tier === "registered" && unchanged) {
    return { kind: "approved", reasons: ["Registered firm, details unchanged since last human approval, checks passed."] };
  }

  const missing: string[] = [];
  if (!evidence.firmEmailVerified) missing.push("Firm has not confirmed by email.");
  if (!evidence.bankLetterOnFile) missing.push("Bank letter or statement header not on file.");
  if (evidence.accountNameMatches !== true && !evidence.callbackCompleted) {
    missing.push("Account name check unavailable: phone call-back to the firm is required.");
  }
  if (missing.length > 0) return { kind: "needs_more_evidence", reasons: missing };

  return {
    kind: "awaiting_human_approval",
    reasons: [unchanged ? "Unregistered firm: full verification passed." : "New or changed bank details: a person must approve."]
  };
}
