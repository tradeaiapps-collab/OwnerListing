import { randomUUID } from "node:crypto";
import { readAppMode } from "../config/app-mode";
import type { StaffActor } from "../domain/staff-access";
import { normaliseStaffEmail } from "../domain/staff-invite";
import { isRoleKey, resolveRoleAccess } from "../domain/staff-roles";
import type { GoogleIdentity } from "./auth/google";
import { mfaClaimValid } from "../domain/mfa";
import { STAFF_TTL_SECONDS, staffTokenFromRequest, verifyStaffSession, type StaffSessionPayload } from "./auth/staff-session";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Staff sign-in for a verified Google identity (readIdentity already requires email_verified=true). Any Google account may be used, but
 * the normalised email must exactly match an active staff_invite. The role comes from that invite, never from Google. An invite whose
 * custom role is missing or disabled cannot sign in.
 * `bootstrap` (env STAFF_BOOTSTRAP_ADMIN_EMAILS) can create a super_admin invite for a listed email, and only while no active super_admin exists.
 * The login account is an app_user of type 'admin', created on first sign-in. An existing account with that email that is not an
 * active admin (for example an owner account) is never converted: the sign-in is denied. Every denial looks the same to the caller
 * (null) and is audited with a reason but without the email.
 */
export async function staffSignIn(db: Queryable, who: GoogleIdentity, bootstrap: readonly string[] = []): Promise<StaffActor | null> {
  const audit = (actorType: "user" | "system", actorId: string, eventType: string, payload: Record<string, unknown>) =>
    appendAuditPg(db, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId,
      aggregateType: "staff_session", aggregateId: actorId, eventType, correlationId: randomUUID(), payload
    });
  const deny = async (reason: string) => {
    await audit("system", "anonymous", "staff.signin_denied", { reason });
    return null;
  };

  const email = normaliseStaffEmail(who.email);
  if (!email || !who.sub) return deny("bad_identity");

  if (bootstrap.includes(email)) {
    // One transaction under the same advisory lock as changeInvite, so two bootstrap sign-ins cannot both see "no super_admin" and both insert.
    const run = (tx: Queryable) => tx.query(`SELECT pg_advisory_xact_lock(hashtext('staff_invite_admins'))`).then(() => tx.query(
      `INSERT INTO staff_invite (email, role, invited_by)
       SELECT $1, 'super_admin', NULL
        WHERE NOT EXISTS (SELECT 1 FROM staff_invite WHERE role = 'super_admin' AND revoked_at IS NULL)
       ON CONFLICT DO NOTHING RETURNING id`,
      [email]
    )).then(async r => {
      const newId = r.rows[0]?.["id"];
      if (typeof newId === "string") {
        await appendAuditPg(tx, {
          id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "system", actorId: "bootstrap",
          aggregateType: "staff_invite", aggregateId: newId, eventType: "staff.bootstrap_admin_created", correlationId: randomUUID(), payload: {}
        });
      }
    });
    await (db.transaction ? db.transaction(run) : run(db));
  }
  const invite = (await db.query(`SELECT id, role FROM staff_invite WHERE email = $1 AND revoked_at IS NULL`, [email])).rows[0];
  const role = invite?.["role"];
  const inviteId = invite?.["id"];
  if (!isRoleKey(role) || typeof inviteId !== "string") return deny("not_invited");
  if (!(await roleUsable(db, role))) return deny("role_disabled");

  const account = (await db.query(`SELECT id, user_type, status, google_sub FROM app_user WHERE email = $1`, [email])).rows[0];
  let id: unknown;
  if (account) {
    if (account["user_type"] !== "admin" || account["status"] !== "active") return deny("account_conflict");
    if (account["google_sub"] === who.sub) id = account["id"];
    else if (account["google_sub"] === null) {
      id = (await db.query(`UPDATE app_user SET google_sub = $1 WHERE id = $2 AND google_sub IS NULL RETURNING id`, [who.sub, account["id"]])).rows[0]?.["id"];
    }
  } else {
    id = (await db.query(
      `INSERT INTO app_user (email, display_name, user_type, status, google_sub) VALUES ($1, $2, 'admin', 'active', $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [email, who.name.slice(0, 200), who.sub]
    )).rows[0]?.["id"];
  }
  if (typeof id !== "string") return deny("account_conflict");

  await db.query(`UPDATE staff_invite SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL`, [inviteId]);
  await audit("user", id, "staff.signed_in", { role });
  return { id, role };
}

/** Built-in roles are always usable; a custom role only while its current definition exists and is enabled. */
async function roleUsable(db: Queryable, role: string): Promise<boolean> {
  if (resolveRoleAccess("x", role, null)) return true;
  const r = (await db.query(`SELECT disabled FROM staff_role_current WHERE role_key = $1`, [role])).rows[0];
  return r?.["disabled"] === false;
}

/**
 * The staff member with user id `uid` as the database holds it now: active admin account, active invite that has been signed in to,
 * and the invite's role resolved to permissions from the current role definition (built-in roles from code). Unknown role: null;
 * disabled custom role: no permissions. Used on every request and again under the lock by every staff access and role change.
 */
export async function loadStaffActor(db: Queryable, uid: string): Promise<StaffActor | null> {
  const res = await db.query(
    `SELECT u.id, i.role, (c.role_key IS NOT NULL) AS role_exists, c.permissions, c.disabled
       FROM app_user u JOIN staff_invite i ON i.email = lower(u.email::text) AND i.revoked_at IS NULL
       LEFT JOIN staff_role_current c ON c.role_key = i.role
      WHERE u.id = $1 AND u.user_type = 'admin' AND u.status = 'active' AND i.accepted_at IS NOT NULL`,
    [uid]
  );
  const row = res.rows[0];
  const id = row?.["id"];
  if (!row || typeof id !== "string") return null;
  return resolveRoleAccess(id, row["role"], { exists: row["role_exists"] === true, permissions: row["permissions"], disabled: row["disabled"] });
}

/** Where a staff session stands on the second sign-in step. Staff MFA is optional: an account that has not enrolled is never asked. */
export interface StaffSessionState {
  staff: StaffActor;
  payload: StaffSessionPayload;
  mfa: { enrolled: boolean; satisfied: boolean };
}

const epoch = (v: unknown): number | undefined => (v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));

/**
 * The staff session for this request, confirmed against the database now, whether or not it has passed MFA yet (role and permissions as
 * loadStaffActor). Same rules as user sessions: removing or resetting a factor ends every session that passed MFA before it, and a reset
 * refuses any session issued at or before it. Only the MFA routes use this directly; staffFromRequest also requires the second step.
 */
export async function staffSessionFromRequest(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<StaffSessionState | null> {
  if (readAppMode() === "public") return null; // defence in depth: a public deployment never honours a staff cookie
  const p = verifyStaffSession(staffTokenFromRequest(req), secret, nowSeconds);
  if (!p) return null;
  const staff = await loadStaffActor(db, p.uid);
  if (!staff) return null;
  const row = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM mfa_factor f WHERE f.user_id = $1::uuid AND f.confirmed_at IS NOT NULL AND f.revoked_at IS NULL) AS enrolled,
            (SELECT floor(extract(epoch FROM max(f.revoked_at)))::bigint FROM mfa_factor f WHERE f.user_id = $1::uuid AND f.confirmed_at IS NOT NULL) AS revoked_at,
            (SELECT floor(extract(epoch FROM max(r.reset_at)))::bigint FROM mfa_reset_log r WHERE r.user_id = $1::uuid) AS reset_at`,
    [p.uid]
  )).rows[0];
  const resetAt = epoch(row?.["reset_at"]);
  if (resetAt !== undefined && p.exp - STAFF_TTL_SECONDS <= resetAt) return null;
  const enrolled = row?.["enrolled"] === true;
  return { staff, payload: p, mfa: { enrolled, satisfied: mfaClaimValid(p.mfa, epoch(row?.["revoked_at"])) } };
}

/**
 * The signed-in staff member for this request, or null. The role and its permissions are read from the database now, so revoking an
 * invite, changing its role or editing the role definition takes effect at once. Only an invite that has been signed in to counts
 * (accepted_at), so a cookie issued under an earlier, revoked invite for the same email never revives when the address is invited again
 * (for example after the mailbox was reassigned); that person must sign in again.
 * A staff member who has set up two-step sign-in counts as signed in only after passing it (cookie without a valid check = null).
 */
export async function staffFromRequest(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<StaffActor | null> {
  const s = await staffSessionFromRequest(db, req, secret, nowSeconds);
  return s && (!s.mfa.enrolled || s.mfa.satisfied) ? s.staff : null;
}
