import { mfaClaimValid, mfaRequired } from "../../domain/mfa";
import type { Actor } from "../../domain/listing-service";
import type { Queryable } from "../db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, readCookie, verifySession, type SessionPayload } from "./session";

/** A signed-in session and where it stands on the second factor. */
export interface SessionState {
  actor: Actor;
  payload: SessionPayload;
  mfa: { required: boolean; enrolled: boolean; satisfied: boolean };
}

const epoch = (v: unknown): number | undefined => (v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));

/**
 * The session for this request, confirmed against the database now, whether or not it has passed MFA yet. The cookie is only a claim:
 * the app_user must exist, be active, and have the same user type as the cookie. Only the MFA routes use this directly; every other
 * route uses actorFromRequestChecked, which also requires the second factor.
 */
export async function sessionFromRequestChecked(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<SessionState | null> {
  const p = verifySession(readCookie(req, SESSION_COOKIE), secret, nowSeconds);
  if (!p) return null;
  const res = await db.query(
    `SELECT u.id, u.user_type,
            EXISTS (SELECT 1 FROM mfa_factor f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL AND f.revoked_at IS NULL) AS mfa_enrolled,
            (SELECT floor(extract(epoch FROM max(f.revoked_at)))::bigint FROM mfa_factor f
              WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa_revoked_at,
            (SELECT floor(extract(epoch FROM max(r.reset_at)))::bigint FROM mfa_reset_log r WHERE r.user_id = u.id) AS mfa_reset_at,
            floor(extract(epoch FROM u.restored_at))::bigint AS restored_at,
            floor(extract(epoch FROM u.password_changed_at))::bigint AS password_changed_at
       FROM app_user u WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND u.user_type = $2`,
    [p.uid, p.ut]
  );
  const row = res.rows[0];
  if (!row || row["id"] !== p.uid || row["user_type"] !== p.ut) return null;
  // A staff reset of the second factor signs the user out everywhere: any session issued at or before it is refused, so a stolen or
  // still-signed-in session cannot enrol a new factor in the user's place. Every session is issued with exp = issue time + TTL.
  const resetAt = epoch(row["mfa_reset_at"]);
  if (resetAt !== undefined && p.exp - SESSION_TTL_SECONDS <= resetAt) return null;
  // A session from before the account was deleted never comes back with a restore: the user signs in again.
  const restoredAt = epoch(row["restored_at"]);
  if (restoredAt !== undefined && p.exp - SESSION_TTL_SECONDS <= restoredAt) return null;
  // A password reset signs the account out everywhere, the same way.
  const passwordAt = epoch(row["password_changed_at"]);
  if (passwordAt !== undefined && p.exp - SESSION_TTL_SECONDS <= passwordAt) return null;
  const enrolled = row["mfa_enrolled"] === true;
  return {
    actor: { userId: p.uid, userType: p.ut },
    payload: p,
    mfa: { required: mfaRequired(p.ut, enrolled), enrolled, satisfied: mfaClaimValid(p.mfa, epoch(row["mfa_revoked_at"])) }
  };
}

/**
 * The signed-in user for this request, confirmed against the database now. Anything else (suspended, closed, deleted, retyped) is
 * denied at once. Owners and agents, and anyone who has enrolled a second factor, count as signed in only after passing it.
 */
export async function actorFromRequestChecked(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<Actor | null> {
  const s = await sessionFromRequestChecked(db, req, secret, nowSeconds);
  return s && (!s.mfa.required || s.mfa.satisfied) ? s.actor : null;
}

/** Cookie-only, no database check: requests must use actorFromRequestChecked. The signed-in user from the session cookie, or null. Fails closed on a missing, forged or expired session. */
export function actorFromRequest(req: Request, secret: string, nowSeconds: number): Actor | null {
  const p = verifySession(readCookie(req, SESSION_COOKIE), secret, nowSeconds);
  return p ? { userId: p.uid, userType: p.ut } : null;
}
