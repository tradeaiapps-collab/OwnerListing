import { decideTrustAccount, type FirmTier, type TrustAccountDecision, type TrustAccountEvidence } from "./trust-account";
import type { Jurisdiction } from "./jurisdiction";

/** The outside services. Real versions call state registers, email and the bank's name check. Tests use stand-ins. */
export interface VerificationPorts {
  registry: { lookup(firmId: string, jurisdiction: Jurisdiction): Promise<{ practisingCertificateCurrent: boolean; registryEmail: string | null }> };
  email: {
    isConfirmed(firmId: string, fingerprint: string): Promise<boolean>;
    sendVerification(to: string, firmId: string, fingerprint: string): Promise<void>;
  };
  /** Returns null when the bank does not support the account name check. */
  nameCheck: { check(bsb: string, accountNumber: string, expectedName: string): Promise<boolean | null> };
  documents: { hasBankLetter(trustAccountId: string): Promise<boolean> };
  callbacks: { isCompleted(trustAccountId: string): Promise<boolean> };
}

export interface TrustAccountInput {
  id: string;
  firmId: string;
  tier: FirmTier;
  jurisdiction: Jurisdiction;
  accountName: string;
  bsb: string;
  accountNumber: string;
  lastHumanApprovedFingerprint?: string;
}

/** Any change to the name, BSB or number changes this value. */
export async function detailsFingerprint(accountName: string, bsb: string, accountNumber: string): Promise<string> {
  const text = [accountName.trim().toLowerCase(), bsb.replace(/\D/g, ""), accountNumber.replace(/\D/g, "")].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export interface VerificationResult {
  decision: TrustAccountDecision;
  evidence: TrustAccountEvidence;
  fingerprint: string;
  /** True when a person must act: flagged, rejected, or waiting for approval. */
  openAdminCase: boolean;
}

/**
 * Runs all automated checks for one job. If anything fails to run, the case is flagged for an
 * admin instead of guessing. Account numbers are never returned or logged.
 */
export async function verifyTrustAccount(input: TrustAccountInput, ports: VerificationPorts): Promise<VerificationResult> {
  let fingerprint = "";
  let evidence: TrustAccountEvidence;
  try {
    fingerprint = await detailsFingerprint(input.accountName, input.bsb, input.accountNumber);
    const reg = await ports.registry.lookup(input.firmId, input.jurisdiction);
    let emailConfirmed = await ports.email.isConfirmed(input.firmId, fingerprint);
    if (!emailConfirmed && reg.registryEmail) {
      await ports.email.sendVerification(reg.registryEmail, input.firmId, fingerprint);
      emailConfirmed = false;
    }
    const [accountNameMatches, bankLetterOnFile, callbackCompleted] = await Promise.all([
      ports.nameCheck.check(input.bsb, input.accountNumber, input.accountName),
      ports.documents.hasBankLetter(input.id),
      ports.callbacks.isCompleted(input.id)
    ]);
    evidence = {
      practisingCertificateCurrent: reg.practisingCertificateCurrent,
      firmEmailVerified: emailConfirmed,
      accountNameMatches,
      bankLetterOnFile,
      callbackCompleted
    };
  } catch (e) {
    evidence = {
      practisingCertificateCurrent: false, firmEmailVerified: false, accountNameMatches: null,
      bankLetterOnFile: false, callbackCompleted: false,
      automationError: e instanceof Error ? e.message : "Unknown error"
    };
  }
  const decision = decideTrustAccount(input.tier, evidence, fingerprint, input.lastHumanApprovedFingerprint);
  const openAdminCase = decision.kind === "flagged_for_admin" || decision.kind === "rejected" || decision.kind === "awaiting_human_approval";
  return { decision, evidence, fingerprint, openAdminCase };
}
