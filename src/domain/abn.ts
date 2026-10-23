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

export interface AbnRecord { abn: string; active: boolean; entityName: string }

/** The real version calls the Australian Business Register's ABN Lookup web service (free, needs a registered access key). */
export interface AbnLookupPort { lookup(abn: string): Promise<AbnRecord | null> }

export interface BusinessBuyerClaim {
  abn: string;
  declaredEntityName: string;
  /** A reviewer saw proof that the person is allowed to act for the business (director, trustee, authority letter). */
  authorityDocumentReviewed: boolean;
}

const SUFFIXES = /\b(pty|ltd|limited|proprietary|trust|trustee|the)\b/g;
function simplifyName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

/**
 * Checks a business buyer: valid ABN, active on the register, name matches, the acting person is ID-verified,
 * and their authority has been reviewed. If the register cannot be reached, an admin must take over.
 */
export async function verifyBusinessBuyer(
  claim: BusinessBuyerClaim, actingPersonIdVerified: boolean, port: AbnLookupPort
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const abn = normaliseAbn(claim.abn);
  if (abn === null || !isValidAbnChecksum(abn)) {
    return { ok: false, problems: ["The ABN is not valid."] };
  }
  try {
    const rec = await port.lookup(abn);
    if (rec === null) problems.push("The ABN was not found on the register.");
    else {
      if (!rec.active) problems.push("The ABN is not active.");
      if (simplifyName(rec.entityName) !== simplifyName(claim.declaredEntityName)) {
        problems.push("The business name does not match the register. A reviewer should check trading names.");
      }
    }
  } catch {
    problems.push("The ABN register could not be checked. An admin must verify this business.");
  }
  if (!actingPersonIdVerified) problems.push("The person acting for the business has not passed the ID check.");
  if (!claim.authorityDocumentReviewed) problems.push("Proof of authority to act for the business has not been reviewed.");
  return { ok: problems.length === 0, problems };
}

/** Business buyers are re-checked on the register regularly, because an ABN can be cancelled after approval. */
export const ABN_RECHECK_DAYS = 30;
export function abnRecheckDue(lastCheckedAt: Date | null, now: Date): boolean {
  if (lastCheckedAt === null) return true;
  return now.getTime() - lastCheckedAt.getTime() >= ABN_RECHECK_DAYS * 86_400_000;
}
