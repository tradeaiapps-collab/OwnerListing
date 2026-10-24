import { NextResponse } from "next/server";
import { effectivePermissions, PERMISSION_AREAS, PERMISSION_CATALOGUE } from "../../../../src/domain/staff-access";
import { parseRoleCreate } from "../../../../src/domain/staff-roles";
import { getDb } from "../../../../src/server/context";
import { createRole, listRoles } from "../../../../src/server/staff-roles-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";

/** The permission catalogue and every role (built-in and custom) as it stands now. Staff managers only (staff.manage). */
export async function GET(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({
    areas: PERMISSION_AREAS, catalogue: PERMISSION_CATALOGUE, roles: await listRoles(getDb()),
    me: { role: staff.role, permissions: effectivePermissions(staff), canEditRoles: staff.role === "super_admin" }
  }, { headers: { "cache-control": "no-store" } });
}

/** Creates a custom role. Body { key: "custom_...", label, description, permissions: [...] }. Super admin only; never beyond your own access. Audited. */
export async function POST(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const input = parseRoleCreate(await readJsonObject(req));
  if (!input.ok) return fail(400, input.error);
  const r = await createRole(getDb(), staff, input.value);
  return r.ok ? NextResponse.json({ ok: true, key: r.key, version: r.version }, { status: 201 }) : fail(r.status, r.error);
}
