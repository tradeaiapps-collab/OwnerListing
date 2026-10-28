import type { MfaResetTarget } from "../domain/mfa-reset";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export interface MfaResetView extends MfaResetTarget {
  displayName: string;
  /** Confirmed methods only, with the phone shown as its last 3 digits. */
  methods: { kind: "totp" | "sms"; label: string; addedAt: string; lastUsedAt: string | null }[];
  recoveryCodesLeft: number;
  resets: { resetAt: string; reason: string; methodsRevoked: number; resetBy: string }[];
}

/** The account with this email (or id) and where it stands on two-step sign-in. Every statement is parameterised. */
export async function findMfaResetTarget(db: Queryable, by: { email: string } | { id: string }): Promise<MfaResetView | null> {
  const u = (await db.query(
    `SELECT u.id, u.email::text AS email, u.display_name, u.user_type, u.status,
            (SELECT count(*)::int FROM mfa_factor f WHERE f.user_id = u.id AND f.revoked_at IS NULL) AS live,
            (SELECT count(*)::int FROM mfa_recovery_code c WHERE c.user_id = u.id AND c.used_at IS NULL AND c.retired_at IS NULL) AS codes
       FROM app_user u WHERE ${"email" in by ? "u.email = $1" : "u.id = $1::uuid"}`, ["email" in by ? by.email : by.id])).rows[0];
  if (!u) return null;
  const id = String(u["id"]);
  const methods = (await db.query(
    `SELECT kind, phone_e164, created_at, last_used_at FROM mfa_factor
      WHERE user_id = $1::uuid AND confirmed_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at`, [id])).rows;
  const resets = (await db.query(
    `SELECT r.reset_at, r.reason, r.methods_revoked, s.email::text AS reset_by FROM mfa_reset_log r JOIN app_user s ON s.id = r.reset_by
      WHERE r.user_id = $1::uuid ORDER BY r.reset_at DESC LIMIT 10`, [id])).rows;
  return {
    id, email: String(u["email"]), displayName: String(u["display_name"]), userType: String(u["user_type"]), status: String(u["status"]),
    liveMethods: Number(u["live"] ?? 0),
    methods: methods.map(m => ({
      kind: m["kind"] === "sms" ? "sms" as const : "totp" as const,
      label: m["kind"] === "sms" ? `Text message to •••• ${String(m["phone_e164"] ?? "").slice(-3)}` : "Authenticator app",
      addedAt: iso(m["created_at"]),
      lastUsedAt: m["last_used_at"] ? iso(m["last_used_at"]) : null
    })),
    recoveryCodesLeft: methods.length ? Number(u["codes"] ?? 0) : 0,
    resets: resets.map(r => ({ resetAt: iso(r["reset_at"]), reason: String(r["reason"]), methodsRevoked: Number(r["methods_revoked"]), resetBy: String(r["reset_by"]) }))
  };
}

/**
 * Resets the user's two-step sign-in in one transaction: revokes every live method (which ends every session that passed MFA
 * before now), retires the recovery codes, voids any open text code, and writes the reset log and MFA event log. Null when another
 * reset got there first (nothing left to revoke).
 */
export async function resetUserMfa(db: Queryable, staffId: string, userId: string, reason: string): Promise<{ methodsRevoked: number; resetAt: string } | null> {
  const write = async (q: Queryable) => {
    const revoked = await q.query("UPDATE mfa_factor SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL RETURNING id", [userId]);
    if (revoked.rows.length === 0) return null;
    await q.query("UPDATE mfa_recovery_code SET retired_at = now() WHERE user_id = $1::uuid AND retired_at IS NULL", [userId]);
    await q.query("UPDATE mfa_sms_code SET consumed_at = now() WHERE user_id = $1::uuid AND consumed_at IS NULL", [userId]);
    const log = await q.query(
      "INSERT INTO mfa_reset_log (user_id, reset_by, reason, methods_revoked) VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING reset_at",
      [userId, staffId, reason, revoked.rows.length]);
    await q.query("INSERT INTO mfa_event_log (user_id, event, method, ip_hash) VALUES ($1::uuid, 'staff_reset', NULL, NULL)", [userId]);
    return { methodsRevoked: revoked.rows.length, resetAt: iso(log.rows[0]!["reset_at"]) };
  };
  return db.transaction ? db.transaction(write) : write(db);
}
