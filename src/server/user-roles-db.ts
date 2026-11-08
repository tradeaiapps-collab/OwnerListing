import { heldRoles, sessionTypeFor, type UserRole } from "../domain/roles";
import type { Queryable } from "./db";

export interface RoleState { primary: string; roles: UserRole[]; currentRole: UserRole | null }

export async function readRoles(db: Queryable, userId: string): Promise<RoleState | null> {
  const r = await db.query(`SELECT user_type, roles, active_role FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [userId]);
  const row = r.rows[0];
  if (!row) return null;
  const roles = heldRoles(String(row["user_type"]), Array.isArray(row["roles"]) ? row["roles"] : []);
  const cur = row["active_role"];
  return { primary: String(row["user_type"]), roles, currentRole: roles.find(x => x === cur) ?? null };
}

/** Adds a role to the account (investor also adds buyer, since investors are buyer accounts). Returns the roles now held. */
export async function activateRole(db: Queryable, userId: string, role: UserRole): Promise<UserRole[] | null> {
  const add = role === "investor" ? ["buyer", "investor"] : [role];
  const r = await db.query(
    `UPDATE app_user SET roles = ARRAY(SELECT DISTINCT x FROM unnest(roles || $2::text[]) AS x)
      WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND user_type IN ('owner','agent','buyer','investor')
      RETURNING user_type, roles`,
    [userId, add]
  );
  const row = r.rows[0];
  return row ? heldRoles(String(row["user_type"]), Array.isArray(row["roles"]) ? row["roles"] : []) : null;
}

export async function saveCurrentRole(db: Queryable, userId: string, role: UserRole): Promise<void> {
  await db.query(`UPDATE app_user SET active_role = $2 WHERE id = $1`, [userId, role]);
}

export { sessionTypeFor };
