import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { StaffActor, StaffPermission } from "../domain/staff-access";
import { staffCan } from "../domain/staff-access";
import { csrfGuard } from "./csrf";
import { getDb, getStaff } from "./context";
import { appendAuditPg } from "./db";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Common start of every staff route: CSRF check on state-changing methods, then the signed-in staff member
 * (role read from the database now), then the permission. Returns the staff member or the response to send.
 */
export async function staffGate(req: Request, permission: StaffPermission): Promise<StaffActor | NextResponse> {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return fail(401, "Sign in as staff.");
  if (!staffCan(staff, permission)) return fail(403, "Not allowed.");
  return staff;
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export const staffAudit = (staff: StaffActor, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(getDb(), {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id,
    aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload: { role: staff.role, ...payload }
  });
