import { checksToPerform, verifyTrustAccount, type TrustAccountInput, type VerificationPorts, type VerificationResult } from "../domain/trust-verification";
import type { Queryable } from "./db";

/**
 * Saves one verification run as a new trust_account_check row (history is kept) and, when a person must act, opens an
 * admin_case of kind trust_account_verification whose subject_id is that check id. Returns the check id.
 * Nothing here approves anything: only an 'approved' check (auto, or two people) lets a listing publish.
 */
export async function recordTrustVerification(db: Queryable, listingId: string, trustAccountId: string, result: VerificationResult): Promise<string> {
  const reasons = result.decision.reasons;
  const todo = checksToPerform(result.decision.kind, result.evidence);
  const res = await db.query(
    `WITH chk AS (INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons)
                  VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id),
          cs AS (INSERT INTO admin_case (kind, subject_id, reason)
                 SELECT 'trust_account_verification', id, $6 FROM chk WHERE $7::boolean RETURNING id)
     SELECT id FROM chk`,
    [listingId, trustAccountId, result.decision.kind, JSON.stringify(result.evidence), JSON.stringify(reasons),
      [...reasons, ...todo].join(" "), result.openAdminCase]
  );
  return String(res.rows[0]?.["id"]);
}

/** Runs the automated checks for one job and records the outcome. A failure to run is itself recorded as flagged_for_admin. */
export async function runAndRecordTrustVerification(
  db: Queryable, listingId: string, input: TrustAccountInput, ports: VerificationPorts
): Promise<VerificationResult & { checkId: string }> {
  const result = await verifyTrustAccount(input, ports);
  return { ...result, checkId: await recordTrustVerification(db, listingId, input.id, result) };
}
