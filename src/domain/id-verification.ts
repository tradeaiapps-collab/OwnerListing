import { staffCan, type StaffActor } from "./staff-access";

export type IdDocumentKind = "drivers_licence" | "passport" | "other_government_id";
export type IdStatus = "pending" | "approved" | "rejected" | "needs_more";
export type IdMethod = "manual_review" | "provider";

/** Document numbers are never stored: only image references, the kind, the country and the expiry. */
export interface IdSubmission {
  id: string;
  userId: string;
  documentKind: IdDocumentKind;
  /** Two-letter country code of the issuing country. */
  documentCountry: string;
  /** YYYY-MM-DD */
  expiryDate: string;
  frontImageRef?: string;
  backImageRef?: string;
  selfieRef?: string;
  /** True only when the selfie was taken live inside our app, not uploaded. */
  selfieCapturedInApp: boolean;
  submittedAt: string;
  status: IdStatus;
  approvals: readonly string[];
  decidedAt?: string;
}

export function validateSubmission(s: IdSubmission, today: string): string[] {
  const p: string[] = [];
  if (!s.frontImageRef) p.push(s.documentKind === "passport" ? "Photo page of the passport is required." : "Front of the document is required.");
  if (s.documentKind !== "passport" && !s.backImageRef) p.push("Back of the document is required.");
  if (!s.selfieRef || !s.selfieCapturedInApp) p.push("A live selfie taken in the app is required.");
  if (!/^[A-Za-z]{2}$/.test(s.documentCountry)) p.push("Issuing country is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.expiryDate) || s.expiryDate < today) p.push("The document must be in date.");
  return p;
}

const MAX_SUBMISSIONS_PER_DAY = 3;

export function canSubmitAgain(recentSubmittedAt: readonly string[], now: string): boolean {
  const cutoff = new Date(now).getTime() - 24 * 3_600_000;
  return recentSubmittedAt.filter(t => new Date(t).getTime() > cutoff).length < MAX_SUBMISSIONS_PER_DAY;
}

/** Overseas documents are harder to judge, so two different reviewers must agree. */
export function requiredApprovals(s: IdSubmission): number {
  return s.documentCountry.toUpperCase() === "AU" ? 1 : 2;
}

export interface ReviewChecklist {
  documentLooksGenuine: boolean;
  photoMatchesSelfie: boolean;
  nameMatchesAccount: boolean;
  notExpired: boolean;
  /**
   * For Australian driver licences: the reviewer checks the licence is current on the state's official
   * status page where one exists. "not_available" means the state has no such page. Passports have no public check.
   */
  officialStatusCheck?: "done" | "not_available" | "failed";
}

export type ReviewOutcome = "approve" | "reject" | "needs_more";

/** Applies one reviewer's decision. Approval needs every check ticked, and enough different reviewers. */
export function reviewSubmission(
  s: IdSubmission, reviewer: StaffActor, outcome: ReviewOutcome, checklist: ReviewChecklist, now: string
): IdSubmission {
  if (!staffCan(reviewer, "identity.review")) throw new Error("This role cannot review identity checks.");
  if (reviewer.id === s.userId) throw new Error("Staff cannot review their own identity check.");
  if (s.status !== "pending") throw new Error("This submission is not waiting for review.");
  if (outcome === "reject") return { ...s, status: "rejected", decidedAt: now };
  if (outcome === "needs_more") return { ...s, status: "needs_more", decidedAt: now };
  const { documentLooksGenuine, photoMatchesSelfie, nameMatchesAccount, notExpired } = checklist;
  if (![documentLooksGenuine, photoMatchesSelfie, nameMatchesAccount, notExpired].every(Boolean)) {
    throw new Error("Every check must pass to approve.");
  }
  if (s.documentKind === "drivers_licence" && s.documentCountry.toUpperCase() === "AU") {
    if (checklist.officialStatusCheck === "failed") throw new Error("The official licence status check failed.");
    if (checklist.officialStatusCheck === undefined) throw new Error("Record the result of the official licence status check.");
  }
  if (s.approvals.includes(reviewer.id)) throw new Error("A different reviewer must give the second approval.");
  const approvals = [...s.approvals, reviewer.id];
  return approvals.length >= requiredApprovals(s)
    ? { ...s, approvals, status: "approved", decidedAt: now }
    : { ...s, approvals };
}

export function isIdVerified(s: IdSubmission): boolean {
  return s.status === "approved";
}

/** Days to keep the ID images after a decision. Counsel to confirm. Afterwards only the result is kept. "Needs more" counts as a rejection. */
export const RETAIN_IMAGE_DAYS = { approved: 7, rejected: 30, needs_more: 30 } as const;

export function imagesDueForDeletion(s: IdSubmission, now: string): boolean {
  if (s.decidedAt === undefined || s.status === "pending") return false;
  return new Date(now).getTime() >= new Date(s.decidedAt).getTime() + RETAIN_IMAGE_DAYS[s.status] * 86_400_000;
}

/** What an outside provider must offer, so it can replace manual review without other changes. */
export interface IdProviderPort {
  startCheck(userId: string, returnUrl: string): Promise<{ redirectUrl: string }>;
  /** Returns null if the signature is invalid. */
  verifyAndParseWebhook(rawBody: string, headers: Readonly<Record<string, string>>): { userId: string; passed: boolean; providerRef: string } | null;
}
