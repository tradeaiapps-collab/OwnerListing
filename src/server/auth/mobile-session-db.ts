import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import {
  MOBILE_ACCESS_TTL_SECONDS, MOBILE_IDLE_TTL_SECONDS, MOBILE_MAX_TTL_SECONDS, hashRefreshSecret, newRefreshToken, parseRefreshToken, sameHash,
  signMobileAccess, type MobileUserType
} from "./mobile-token";

/** What the app stores after signing in or refreshing. */
export interface MobileTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  /** Seconds until the access token expires. */
  expiresIn: number;
  sessionId: string;
}

const epoch = (v: unknown): number | undefined => (v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
const label = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
const platformOf = (v: unknown): "android" | "ios" | null => (v === "android" || v === "ios" ? v : null);

function accessFor(user: { id: string; userType: MobileUserType }, sessionId: string, secret: string, nowSeconds: number) {
  return signMobileAccess({ uid: user.id, ut: user.userType, sid: sessionId, exp: nowSeconds + MOBILE_ACCESS_TTL_SECONDS }, secret);
}

/** Starts a phone session for a user who has just passed the password check. The second step (when needed) comes after. */
export async function createMobileSession(
  db: Queryable, user: { id: string; userType: MobileUserType }, device: { label?: unknown; platform?: unknown }, secret: string, nowSeconds: number
): Promise<MobileTokens> {
  const id = randomUUID();
  const refresh = newRefreshToken(id);
  await db.query(
    `INSERT INTO mobile_session (id, user_id, user_type, refresh_hash, device_label, platform, created_at, last_used_at, expires_at, max_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($7), to_timestamp($8), to_timestamp($9))`,
    [id, user.id, user.userType, refresh.hash, label(device.label), platformOf(device.platform), nowSeconds,
      nowSeconds + MOBILE_IDLE_TTL_SECONDS, nowSeconds + MOBILE_MAX_TTL_SECONDS]
  );
  return { accessToken: accessFor(user, id, secret, nowSeconds), refreshToken: refresh.token, tokenType: "Bearer", expiresIn: MOBILE_ACCESS_TTL_SECONDS, sessionId: id };
}

export type RefreshOutcome = { ok: true; tokens: MobileTokens } | { ok: false; reason: "invalid" | "reuse" | "expired" | "account" };

const revoke = (db: Queryable, id: string, reason: "reuse" | "expired" | "account" | "sign_out") =>
  db.query(`UPDATE mobile_session SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, reason]);

/**
 * Swaps a refresh token for a new pair. Each refresh token works once: any token this session already swapped (every one is kept, as a
 * hash) coming back means two copies exist, so the whole session is revoked and the phone must sign in again. The account is re-checked here too, so a suspension,
 * deletion, password reset or staff MFA reset after this phone signed in ends the session.
 */
export async function refreshMobileSession(db: Queryable, token: unknown, secret: string, nowSeconds: number): Promise<RefreshOutcome> {
  const parsed = parseRefreshToken(token);
  if (!parsed) return { ok: false, reason: "invalid" };
  const run = async (tx: Queryable): Promise<RefreshOutcome> => {
    const row = (await tx.query(
      `SELECT s.id, s.user_id, s.user_type, s.refresh_hash, s.previous_refresh_hash, s.revoked_at,
              floor(extract(epoch FROM s.created_at))::bigint AS created_at,
              floor(extract(epoch FROM s.expires_at))::bigint AS expires_at,
              floor(extract(epoch FROM s.max_expires_at))::bigint AS max_expires_at,
              u.status, u.deleted_at, u.user_type AS account_type,
              (SELECT floor(extract(epoch FROM max(r.reset_at)))::bigint FROM mfa_reset_log r WHERE r.user_id = u.id) AS mfa_reset_at,
              floor(extract(epoch FROM u.restored_at))::bigint AS restored_at,
              floor(extract(epoch FROM u.password_changed_at))::bigint AS password_changed_at
         FROM mobile_session s JOIN app_user u ON u.id = s.user_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [parsed.sessionId]
    )).rows[0];
    if (!row || row["revoked_at"] !== null) return { ok: false, reason: "invalid" };
    const hash = hashRefreshSecret(parsed.secret);
    const retired = (await tx.query(`SELECT 1 FROM mobile_session_retired_refresh WHERE session_id = $1 AND refresh_hash = $2`, [parsed.sessionId, hash])).rows.length > 0;
    if (retired || sameHash(row["previous_refresh_hash"] as string | null, hash)) {
      await revoke(tx, parsed.sessionId, "reuse");
      return { ok: false, reason: "reuse" };
    }
    if (!sameHash(row["refresh_hash"] as string, hash)) return { ok: false, reason: "invalid" };
    if ((epoch(row["expires_at"]) ?? 0) <= nowSeconds || (epoch(row["max_expires_at"]) ?? 0) <= nowSeconds) {
      await revoke(tx, parsed.sessionId, "expired");
      return { ok: false, reason: "expired" };
    }
    const created = epoch(row["created_at"]) ?? 0;
    const endedBy = [row["mfa_reset_at"], row["restored_at"], row["password_changed_at"]].map(epoch).some(t => t !== undefined && created <= t);
    if (row["status"] !== "active" || row["deleted_at"] !== null || row["account_type"] !== row["user_type"] || endedBy) {
      await revoke(tx, parsed.sessionId, "account");
      return { ok: false, reason: "account" };
    }
    const next = newRefreshToken(parsed.sessionId);
    await tx.query(`INSERT INTO mobile_session_retired_refresh (session_id, refresh_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [parsed.sessionId, hash]);
    const maxExp = epoch(row["max_expires_at"]) ?? nowSeconds;
    await tx.query(
      `UPDATE mobile_session SET previous_refresh_hash = refresh_hash, refresh_hash = $2, last_used_at = to_timestamp($3), expires_at = to_timestamp($4)
        WHERE id = $1`,
      [parsed.sessionId, next.hash, nowSeconds, Math.min(nowSeconds + MOBILE_IDLE_TTL_SECONDS, maxExp)]
    );
    const user = { id: String(row["user_id"]), userType: row["user_type"] as MobileUserType };
    return { ok: true, tokens: { accessToken: accessFor(user, parsed.sessionId, secret, nowSeconds), refreshToken: next.token, tokenType: "Bearer", expiresIn: MOBILE_ACCESS_TTL_SECONDS, sessionId: parsed.sessionId } };
  };
  return db.transaction ? db.transaction(run) : run(db);
}

/** Records that this phone passed the second sign-in step now. */
export async function markMobileMfaPassed(db: Queryable, sessionId: string, userId: string): Promise<boolean> {
  const r = await db.query(`UPDATE mobile_session SET mfa_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [sessionId, userId]);
  return r.rows.length === 1;
}

/** Signs this phone out. Only the user's own session can be ended. */
export async function signOutMobileSession(db: Queryable, sessionId: string, userId: string): Promise<void> {
  await db.query(`UPDATE mobile_session SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId]);
}

/** The phone session behind an access token, while it is live: when it started and when it last passed MFA. */
export async function liveMobileSession(db: Queryable, sessionId: string, userId: string): Promise<{ createdAt: number; mfaAt: number | undefined } | null> {
  const row = (await db.query(
    `SELECT floor(extract(epoch FROM created_at))::bigint AS created_at, floor(extract(epoch FROM mfa_at))::bigint AS mfa_at
       FROM mobile_session WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now() AND max_expires_at > now()`,
    [sessionId, userId]
  )).rows[0];
  if (!row) return null;
  return { createdAt: epoch(row["created_at"]) ?? 0, mfaAt: epoch(row["mfa_at"]) };
}
