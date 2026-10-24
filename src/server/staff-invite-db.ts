import { randomUUID } from "node:crypto";
import { staffCan, type StaffActor } from "../domain/staff-access";
import { planInviteChange, type InviteDenyReason } from "../domain/staff-invite";
import { isRoleKey, planOutrank, planRoleAssign, type RoleDenyReason } from "../domain/staff-roles";
import { appendAuditPg, type Queryable } from "./db";
import { loadStaffActor } from "./staff-auth";
import { getRole, STAFF_ACCESS_LOCK } from "./staff-roles-db";

const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

export interface InviteRow {
  id: string; email: string; role: string; invitedBy: string | null; createdAt: string | null;
  acceptedAt: string | null; revokedAt: string | null; revokedBy: string | null;
}

/** Every invite, active first, then history. */
export async function listInvites(db: Queryable): Promise<InviteRow[]> {
  const res = await db.query(
    `SELECT id, email, role, invited_by, created_at, accepted_at, revoked_at, revoked_by FROM staff_invite
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 500`
  );
  return res.rows.flatMap(r => {
    const role = r["role"];
    return isRoleKey(role) ? [{
      id: String(r["id"]), email: String(r["email"]), role, invitedBy: (r["invited_by"] as string | null) ?? null, createdAt: iso(r["created_at"]),
      acceptedAt: iso(r["accepted_at"]), revokedAt: iso(r["revoked_at"]), revokedBy: (r["revoked_by"] as string | null) ?? null
    }] : [];
  });
}

const audit = (tx: Queryable, actor: StaffActor, id: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: actor.id,
    aggregateType: "staff_invite", aggregateId: id, eventType, correlationId: randomUUID(), payload: { role: actor.role, ...payload }
  });

export type InviteResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string };

const AUDITED: readonly (InviteDenyReason | RoleDenyReason)[] = ["self", "last_admin", "escalation", "sensitive", "outranked"];

/**
 * Adds an active invite. The caller has already checked staff.manage and normalised the email. Under the staff access lock the actor is
 * re-read and the role must exist, be enabled and be within the actor's own access (planRoleAssign). The email is kept out of the audit row.
 */
export async function createInvite(db: Queryable, actorIn: StaffActor, email: string, role: string): Promise<InviteResult> {
  return atomic(db, async tx => {
    await tx.query(STAFF_ACCESS_LOCK);
    const actor = await loadStaffActor(tx, actorIn.id);
    if (!actor || !staffCan(actor, "staff.manage")) return { ok: false as const, status: 403, error: "Not allowed." };
    const assign = planRoleAssign(actor, await getRole(tx, role));
    if (!assign.ok) {
      if (AUDITED.includes(assign.reason)) await audit(tx, actor, "new", "staff.invite_change_refused", { reason: assign.reason, action: "invite", inviteRole: role });
      return { ok: false as const, status: assign.status, error: assign.error };
    }
    const res = await tx.query(
      `INSERT INTO staff_invite (email, role, invited_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [email, role, actor.id]
    );
    const id = res.rows[0]?.["id"];
    if (typeof id !== "string") return { ok: false as const, status: 409, error: "That email already has an active invite." };
    await audit(tx, actor, id, "staff.invite_created", { inviteRole: role });
    return { ok: true as const, id };
  });
}

/**
 * Revokes an invite (newRole null) or changes its role (revokes it and adds a new row, so history is kept). One transaction under an
 * advisory lock so two concurrent changes cannot remove the last two admins. Self changes, the last admin, changing someone with more
 * access than you, and giving access you do not hold are refused and audited.
 */
export async function changeInvite(db: Queryable, actorIn: StaffActor, inviteId: string, newRole: string | null): Promise<InviteResult> {
  return atomic(db, async tx => {
    await tx.query(STAFF_ACCESS_LOCK);
    // The acting admin is checked again under the lock: a request that passed the gate just before the actor was itself revoked or demoted is refused.
    const actor = await loadStaffActor(tx, actorIn.id);
    if (!actor) return { ok: false as const, status: 403, error: "Not allowed." };
    const t = (await tx.query(
      `SELECT i.id, i.email, i.role,
              EXISTS (SELECT 1 FROM app_user a WHERE a.id = $2 AND lower(a.email::text) = i.email) AS is_self
         FROM staff_invite i WHERE i.id = $1 AND i.revoked_at IS NULL`,
      [inviteId, actor.id]
    )).rows[0];
    const role = t?.["role"];
    const target = t && isRoleKey(role) ? { id: String(t["id"]), email: String(t["email"]), role } : null;
    const admins = Number((await tx.query(`SELECT count(*) AS n FROM staff_invite WHERE role = 'super_admin' AND revoked_at IS NULL`)).rows[0]?.["n"] ?? 0);
    const refuse = async (p: { status: number; error: string; reason: InviteDenyReason | RoleDenyReason }) => {
      if (AUDITED.includes(p.reason)) await audit(tx, actor, inviteId, "staff.invite_change_refused", { reason: p.reason, action: newRole ? "set_role" : "revoke" });
      return { ok: false as const, status: p.status, error: p.error };
    };
    const plan = planInviteChange(actor, target, t?.["is_self"] === true, admins, newRole);
    if (!plan.ok) return refuse(plan);
    const outrank = planOutrank(actor, await getRole(tx, target!.role));
    if (!outrank.ok) return refuse(outrank);
    if (newRole !== null) {
      const assign = planRoleAssign(actor, await getRole(tx, newRole));
      if (!assign.ok) return refuse(assign);
    }
    await tx.query(`UPDATE staff_invite SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`, [inviteId, actor.id]);
    if (newRole === null) {
      await audit(tx, actor, inviteId, "staff.invite_revoked", { inviteRole: role });
      return { ok: true as const, id: inviteId };
    }
    const added = await tx.query(
      `INSERT INTO staff_invite (email, role, invited_by, accepted_at)
       SELECT email, $2, $3, accepted_at FROM staff_invite WHERE id = $1 RETURNING id`,
      [inviteId, newRole, actor.id]
    );
    const id = String(added.rows[0]?.["id"]);
    await audit(tx, actor, id, "staff.invite_role_changed", { previousRole: role, inviteRole: newRole, replaces: inviteId });
    return { ok: true as const, id };
  });
}
