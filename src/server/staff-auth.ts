import { randomUUID } from "node:crypto";
import { readAppMode } from "../config/app-mode";
import type { StaffActor } from "../domain/staff-access";
import { asStaffRole, normaliseStaffEmail } from "../domain/staff-invite";
import type { GoogleIdentity } from "./auth/google";
import { staffTokenFromRequest, verifyStaffSession } from "./auth/staff-session";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Staff sign-in for a verified Google identity (readIdentity already requires email_verified=true). Any Google account may be used, but
 * the normalised email must exactly match an active staff_invite. The role comes from that invite, never from Google.
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
  const role = asStaffRole(invite?.["role"]);
  const inviteId = invite?.["id"];
  if (!role || typeof inviteId !== "string") return deny("not_invited");

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

/**
 * The signed-in staff member for this request, or null. The role is read from the active invite now, so revoking or changing it takes
 * effect at once. Only an invite that has been signed in to counts (accepted_at), so a cookie issued under an earlier, revoked invite for the
 * same email never revives when the address is invited again (for example after the mailbox was reassigned); that person must sign in again.
 */
export async function staffFromRequest(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<StaffActor | null> {
  if (readAppMode() === "public") return null; // defence in depth: a public deployment never honours a staff cookie
  const p = verifyStaffSession(staffTokenFromRequest(req), secret, nowSeconds);
  if (!p) return null;
  const res = await db.query(
    `SELECT u.id, i.role FROM app_user u JOIN staff_invite i ON i.email = lower(u.email::text) AND i.revoked_at IS NULL
      WHERE u.id = $1 AND u.user_type = 'admin' AND u.status = 'active' AND i.accepted_at IS NOT NULL`,
    [p.uid]
  );
  const row = res.rows[0];
  const role = asStaffRole(row?.["role"]);
  const id = row?.["id"];
  return role && typeof id === "string" ? { id, role } : null;
}
