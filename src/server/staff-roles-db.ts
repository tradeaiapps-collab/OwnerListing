import { randomUUID } from "node:crypto";
import { isSensitivePermission, type StaffActor } from "../domain/staff-access";
import {
  cleanPermissions, isRoleKey, planRoleChange, planRoleCreate, SYSTEM_ROLE_DEFS, type RoleChange, type RoleDef, type RoleDenyReason,
  type RoleInput
} from "../domain/staff-roles";
import { appendAuditPg, type Queryable } from "./db";
import { loadStaffActor } from "./staff-auth";

const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));

/** The same lock as invite changes, so a role edit and an assignment of that role never interleave. */
export const STAFF_ACCESS_LOCK = `SELECT pg_advisory_xact_lock(hashtext('staff_invite_admins'))`;

function toRole(r: Record<string, unknown>): RoleDef | null {
  const key = r["role_key"];
  if (!isRoleKey(key)) return null;
  const sys = SYSTEM_ROLE_DEFS.find(s => s.key === key);
  if (sys) return sys; // built-in roles are fixed in code, whatever the row says
  return {
    key, label: String(r["label"] ?? key), description: String(r["description"] ?? ""), permissions: cleanPermissions(r["permissions"]),
    isSystem: false, disabled: r["disabled"] !== false, version: Number(r["version"])
  };
}

/** Kept below the list limit so the roles page and the access review export always show every custom role. */
const MAX_CUSTOM_ROLES = 150;

const COLS = `role_key, version, label, description, permissions, disabled`;

/** Every role as it stands now: built-in first (in code order), then custom roles by label. */
export async function listRoles(db: Queryable): Promise<RoleDef[]> {
  const rows = (await db.query(`SELECT ${COLS} FROM staff_role_current WHERE NOT is_system ORDER BY label, role_key LIMIT 200`)).rows;
  return [...SYSTEM_ROLE_DEFS, ...rows.map(toRole).filter((r): r is RoleDef => r !== null)];
}

/** One role as it stands now, or null. Pass a transaction to read it under the lock. */
export async function getRole(db: Queryable, key: string): Promise<RoleDef | null> {
  if (!isRoleKey(key)) return null;
  const row = (await db.query(`SELECT ${COLS} FROM staff_role_current WHERE role_key = $1`, [key])).rows[0];
  return row ? toRole(row) : null;
}

export type RoleResult = { ok: true; key: string; version: number } | { ok: false; status: number; error: string };

const audit = (tx: Queryable, actor: StaffActor, key: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: actor.id,
    aggregateType: "staff_role", aggregateId: key, eventType, correlationId: randomUUID(), payload: { role: actor.role, roleKey: key, ...payload }
  });

/** Refusals that point at misuse (not typos or stale pages) are audited too. */
const AUDITED_REFUSALS: readonly RoleDenyReason[] = ["not_super_admin", "system_role", "own_role", "escalation"];

/** Re-reads the acting admin under the lock: a request that passed the gate just before they were revoked or demoted is refused. */
async function actorNow(tx: Queryable, actor: StaffActor): Promise<StaffActor | null> {
  await tx.query(STAFF_ACCESS_LOCK);
  return loadStaffActor(tx, actor.id);
}

/** Creates a custom role (version 1). Audited with the permission list (no personal data). */
export async function createRole(db: Queryable, actorIn: StaffActor, input: RoleInput & { key: string }): Promise<RoleResult> {
  return atomic(db, async tx => {
    const actor = await actorNow(tx, actorIn);
    if (!actor) return { ok: false as const, status: 403, error: "Not allowed." };
    const plan = planRoleCreate(actor, input, await getRole(tx, input.key));
    if (!plan.ok) {
      if (AUDITED_REFUSALS.includes(plan.reason)) await audit(tx, actor, input.key, "staff.role_change_refused", { action: "create", reason: plan.reason });
      return { ok: false as const, status: plan.status, error: plan.error };
    }
    const count = Number((await tx.query(`SELECT count(*) AS n FROM staff_role_def WHERE NOT is_system`)).rows[0]?.["n"] ?? 0);
    if (count >= MAX_CUSTOM_ROLES) return { ok: false as const, status: 409, error: "There are too many custom roles. Disable and reuse one instead." };
    const made = await tx.query(`INSERT INTO staff_role_def (key, is_system, created_by) VALUES ($1, false, $2) ON CONFLICT DO NOTHING RETURNING key`, [input.key, actor.id]);
    if (!made.rows[0]) return { ok: false as const, status: 409, error: "A role with that key already exists." };
    await tx.query(
      `INSERT INTO staff_role_def_version (role_key, version, label, description, permissions, changed_by) VALUES ($1, 1, $2, $3, $4, $5)`,
      [input.key, input.label, input.description, input.permissions, actor.id]
    );
    await audit(tx, actor, input.key, "staff.role_created", { version: 1, added: plan.added, sensitive: plan.added.filter(isSensitivePermission) });
    return { ok: true as const, key: input.key, version: 1 };
  });
}

/** Edits, disables or enables a custom role by adding the next version. Audited with the permission diff. */
export async function changeRole(db: Queryable, actorIn: StaffActor, key: string, change: RoleChange): Promise<RoleResult> {
  return atomic(db, async tx => {
    const actor = await actorNow(tx, actorIn);
    if (!actor) return { ok: false as const, status: 403, error: "Not allowed." };
    const current = await getRole(tx, key);
    const plan = planRoleChange(actor, current, change);
    if (!plan.ok) {
      if (AUDITED_REFUSALS.includes(plan.reason)) await audit(tx, actor, key, "staff.role_change_refused", { action: change.action, reason: plan.reason });
      return { ok: false as const, status: plan.status, error: plan.error };
    }
    const n = plan.next;
    await tx.query(
      `INSERT INTO staff_role_def_version (role_key, version, label, description, permissions, disabled, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [key, n.version, n.label, n.description, n.permissions, n.disabled, actor.id]
    );
    const eventType = change.action === "update" ? "staff.role_updated" : change.action === "disable" ? "staff.role_disabled" : "staff.role_enabled";
    await audit(tx, actor, key, eventType, {
      version: n.version, previousVersion: current?.version, added: plan.added, removed: plan.removed,
      labelChanged: n.label !== current?.label, descriptionChanged: n.description !== current?.description
    });
    return { ok: true as const, key, version: n.version };
  });
}

export interface AccessRow { inviteId: string; email: string; role: string; acceptedAt: string | null }

/** Active invites for the access review export. */
export async function listActiveAccess(db: Queryable): Promise<AccessRow[]> {
  const res = await db.query(`SELECT id, email, role, accepted_at FROM staff_invite WHERE revoked_at IS NULL ORDER BY email LIMIT 2000`);
  return res.rows.map(r => ({
    inviteId: String(r["id"]), email: String(r["email"]), role: String(r["role"]),
    acceptedAt: r["accepted_at"] instanceof Date ? r["accepted_at"].toISOString() : r["accepted_at"] ? String(r["accepted_at"]) : null
  }));
}
