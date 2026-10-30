import { randomUUID } from "node:crypto";
import { appendAuditPg, type Queryable } from "./db";
import type { GoogleIdentity } from "./auth/google";

export interface SignedInUser { id: string; userType: "owner" | "agent" | "buyer" | "vendor" }

/**
 * Finds or creates the user for a verified Google identity, keyed on the Google subject id (not email).
 * `requestedType` only applies when the account is created: an existing account keeps the type it already has, so signing in
 * with a different choice can never switch a user's role. Owner, agent and buyer can be self-selected (an agent account can do
 * nothing agent-only until staff verify a licence). An email-and-password account with the same address and no Google link yet is
 * linked to this Google identity: such accounts exist only after their address was confirmed, and Google has verified it too.
 * Returns null for suspended, closed or deleted accounts (a deleted account's row is left untouched) and for staff or other user types, which cannot use this login yet.
 * A different account already holding the same email makes the insert fail; the caller treats that as a failed login.
 */
export async function upsertGoogleUser(db: Queryable, who: GoogleIdentity, requestedType: "owner" | "agent" | "buyer" = "owner"): Promise<SignedInUser | null> {
  let res: { rows: Record<string, unknown>[] };
  try {
    res = await db.query(
      `INSERT INTO app_user (email, display_name, user_type, status, google_sub)
       VALUES ($1, $2, $4, 'active', $3)
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email WHERE app_user.user_type IN ('owner', 'agent', 'buyer') AND app_user.deleted_at IS NULL
       RETURNING id, user_type, status`,
      [who.email, who.name, who.sub, requestedType]
    );
  } catch (e) {
    // 23505: the email belongs to another account. Link it only when it is an email-and-password account not yet linked to Google.
    if ((e as { code?: unknown }).code !== "23505") throw e;
    res = await db.query(
      `UPDATE app_user SET google_sub = $2
        WHERE email = $1 AND google_sub IS NULL AND password_hash IS NOT NULL AND user_type IN ('owner', 'agent', 'buyer') AND deleted_at IS NULL
        RETURNING id, user_type, status`,
      [who.email, who.sub]
    );
  }
  const row = res.rows[0];
  if (!row || row["status"] !== "active") return null;
  const type = row["user_type"];
  if ((type !== "owner" && type !== "agent" && type !== "buyer") || typeof row["id"] !== "string") return null;
  return { id: row["id"], userType: type };
}

/**
 * Contractor (vendor) sign-in for a verified Google identity. Vendor accounts are pre-registered; this never creates an account and
 * never sets a role. A known Google subject signs in directly. An account not yet linked to Google is linked once, by its
 * pre-registered email (Google has verified it), only while google_sub is empty and the account is an active vendor. Anything else is denied.
 */
export async function vendorSignIn(db: Queryable, who: GoogleIdentity): Promise<{ id: string } | null> {
  const bySub = await db.query(`SELECT id FROM app_user WHERE google_sub = $1 AND user_type = 'vendor' AND status = 'active'`, [who.sub]);
  let row = bySub.rows[0];
  if (!row) {
    const linked = await db.query(
      `UPDATE app_user SET google_sub = $1
        WHERE email = $2 AND google_sub IS NULL AND user_type = 'vendor' AND status = 'active'
        RETURNING id`,
      [who.sub, who.email]
    );
    row = linked.rows[0];
  }
  const id = row?.["id"];
  const ok = typeof id === "string";
  const who_ = ok ? id : "anonymous";
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: ok ? "user" : "system", actorId: who_,
    aggregateType: "vendor_session", aggregateId: who_, eventType: ok ? "vendor.signed_in" : "vendor.signin_denied",
    correlationId: randomUUID(), payload: ok ? {} : { reason: "not_vendor" }
  });
  return ok ? { id } : null;
}
