/** Returns the 11 digits, or null if the text is not an ABN shape. */
export function normaliseAbn(text: string): string | null {
  const digits = text.replace(/\s+/g, "");
  return /^\d{11}$/.test(digits) ? digits : null;
}

const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

/** The official ABN check: subtract 1 from the first digit, weight each digit, and the total must divide by 89. */
export function isValidAbnChecksum(abn: string): boolean {
  const n = normaliseAbn(abn);
  if (n === null) return false;
  const digits = n.split("").map(Number);
  digits[0] = (digits[0] ?? 0) - 1;
  const sum = digits.reduce((acc, d, i) => acc + d * (WEIGHTS[i] ?? 0), 0);
  return sum % 89 === 0;
}

export type AbnValidation = { ok: true; abn: string } | { ok: false; error: string };

/** Pure ABN validation with a plain-words error: spaces stripped, 11 digits, weighted checksum (mod 89). */
export function validateAbn(text: unknown): AbnValidation {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "Enter an ABN (11 digits)." };
  const stripped = text.replace(/\s+/g, "");
  if (!/^\d+$/.test(stripped)) return { ok: false, error: "An ABN contains digits only (spaces are allowed)." };
  if (stripped.length !== 11) return { ok: false, error: "An ABN must be exactly 11 digits." };
  if (!isValidAbnChecksum(stripped)) return { ok: false, error: "This ABN is not valid. Check for a typing mistake." };
  return { ok: true, abn: stripped };
}

/** Where an ABN stands: not confirmed with the register until the ABR lookup has answered. */
export type AbnStatus = "invalid" | "format_valid_not_confirmed" | "confirmed" | "needs_review";
export const ABN_NOT_CONFIRMED_NOTE = "Format valid, not confirmed with ABR. Staff review needed.";

export interface AbnRecord { abn: string; active: boolean; entityName: string; /** true/false when the register says; undefined when unknown. */ gstRegistered?: boolean | undefined }

/** The real version calls the Australian Business Register's ABN Lookup web service (free, needs a registered access key). */
export interface AbnLookupPort { lookup(abn: string): Promise<AbnRecord | null> }

export interface BusinessBuyerClaim {
  abn: string;
  declaredEntityName: string;
  /** A reviewer saw proof that the person is allowed to act for the business (director, trustee, authority letter). */
  authorityDocumentReviewed: boolean;
  /** Optional: what the person declared about GST. Compared with the register when both are known. */
  declaredGstRegistered?: boolean;
}

const SUFFIXES = /\b(pty|ltd|limited|proprietary|trust|trustee|the)\b/g;
function simplifyName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

/**
 * Checks a business buyer: valid ABN, active on the register, name matches, the acting person is ID-verified,
 * and their authority has been reviewed. Fails closed: with no register access (port null, e.g. no ABN_LOOKUP_GUID yet)
 * or if the register cannot be reached, the ABN stays "format valid, not confirmed" and staff must review.
 */
export async function verifyBusinessBuyer(
  claim: BusinessBuyerClaim, actingPersonIdVerified: boolean, port: AbnLookupPort | null
): Promise<{ ok: boolean; problems: string[]; abnStatus: AbnStatus }> {
  const problems: string[] = [];
  const v = validateAbn(claim.abn);
  if (!v.ok) return { ok: false, problems: ["The ABN is not valid."], abnStatus: "invalid" };
  let abnStatus: AbnStatus = "format_valid_not_confirmed";
  if (port === null) {
    problems.push(ABN_NOT_CONFIRMED_NOTE);
  } else {
    try {
      const rec = await port.lookup(v.abn);
      if (rec === null) { problems.push("The ABN was not found on the register."); abnStatus = "needs_review"; }
      else {
        abnStatus = "confirmed";
        if (!rec.active) { problems.push("The ABN is not active."); abnStatus = "needs_review"; }
        if (simplifyName(rec.entityName) !== simplifyName(claim.declaredEntityName)) {
          problems.push("The business name does not match the register. A reviewer should check trading names.");
          abnStatus = "needs_review";
        }
        if (claim.declaredGstRegistered !== undefined && rec.gstRegistered !== undefined && claim.declaredGstRegistered !== rec.gstRegistered) {
          problems.push("The GST status does not match the register.");
          abnStatus = "needs_review";
        }
      }
    } catch {
      problems.push("The ABN register could not be checked. " + ABN_NOT_CONFIRMED_NOTE);
    }
  }
  if (!actingPersonIdVerified) problems.push("The person acting for the business has not passed the ID check.");
  if (!claim.authorityDocumentReviewed) problems.push("Proof of authority to act for the business has not been reviewed.");
  return { ok: problems.length === 0, problems, abnStatus };
}

/** Business buyers are re-checked on the register regularly, because an ABN can be cancelled after approval. */
export const ABN_RECHECK_DAYS = 30;
export function abnRecheckDue(lastCheckedAt: Date | null, now: Date): boolean {
  if (lastCheckedAt === null) return true;
  return now.getTime() - lastCheckedAt.getTime() >= ABN_RECHECK_DAYS * 86_400_000;
}
