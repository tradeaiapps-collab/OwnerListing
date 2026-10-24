import { randomUUID } from "node:crypto";
import type { StaffActor, StaffRole } from "../domain/staff-access";
import type { GoogleIdentity } from "./auth/google";
import { staffTokenFromRequest, verifyStaffSession } from "./auth/staff-session";
import { appendAuditPg, type Queryable } from "./db";

const ROLES: readonly string[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting"];
const asRole = (v: unknown): StaffRole | null => (typeof v === "string" && ROLES.includes(v) ? (v as StaffRole) : null);

/**
 * Staff sign-in for a verified Google identity. Staff accounts are provisioned in advance (app_user with user_type 'admin' and a staff_role);
 * this never creates an account and never sets or changes a role. A known Google subject signs in directly. An account not yet linked to
 * Google is linked once, by its pre-provisioned email (Google has verified it), and only while still active. Anything else is denied.
 */
export async function staffSignIn(db: Queryable, who: GoogleIdentity): Promise<StaffActor | null> {
  const bySub = await db.query(
    `SELECT id, staff_role FROM app_user WHERE google_sub = $1 AND staff_role IS NOT NULL AND user_type = 'admin' AND status = 'active'`,
    [who.sub]
  );
  let row = bySub.rows[0];
  if (!row) {
    const linked = await db.query(
      `UPDATE app_user SET google_sub = $1
        WHERE email = $2 AND google_sub IS NULL AND staff_role IS NOT NULL AND user_type = 'admin' AND status = 'active'
        RETURNING id, staff_role`,
      [who.sub, who.email]
    );
    row = linked.rows[0];
  }
  const role = asRole(row?.["staff_role"]);
  const id = row?.["id"];
  const audit = (actorType: "user" | "system", actorId: string, eventType: string, payload: Record<string, unknown>) =>
    appendAuditPg(db, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId,
      aggregateType: "staff_session", aggregateId: actorId, eventType, correlationId: randomUUID(), payload
    });
  if (!role || typeof id !== "string") {
    await audit("system", "anonymous", "staff.signin_denied", { reason: "not_staff" });
    return null;
  }
  await audit("user", id, "staff.signed_in", { role });
  return { id, role };
}

/** The signed-in staff member for this request, or null. The role is read from the database now, so removing or changing it takes effect at once. */
export async function staffFromRequest(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<StaffActor | null> {
  const p = verifyStaffSession(staffTokenFromRequest(req), secret, nowSeconds);
  if (!p) return null;
  const res = await db.query(
    `SELECT id, staff_role FROM app_user WHERE id = $1 AND staff_role IS NOT NULL AND user_type = 'admin' AND status = 'active'`,
    [p.uid]
  );
  const row = res.rows[0];
  const role = asRole(row?.["staff_role"]);
  const id = row?.["id"];
  return role && typeof id === "string" ? { id, role } : null;
}
