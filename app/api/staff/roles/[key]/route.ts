import { NextResponse } from "next/server";
import { isRoleKey, parseRoleChange } from "../../../../../src/domain/staff-roles";
import { getDb } from "../../../../../src/server/context";
import { changeRole } from "../../../../../src/server/staff-roles-db";
import { fail, readJsonObject, staffGate } from "../../../../../src/server/staff-route";

/**
 * Changes a custom role by adding its next version. Body { action: "update", expectedVersion, label, description, permissions } or
 * { action: "disable" | "enable", expectedVersion }. Super admin only; never a built-in role or your own role; never adds access you lack;
 * a stale expectedVersion (someone else saved first) is refused with 409. Takes effect on everyone's next request. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const { key } = await ctx.params;
  if (!isRoleKey(key)) return fail(404, "Role not found.");
  const change = parseRoleChange(await readJsonObject(req));
  if (!change.ok) return fail(400, change.error);
  const r = await changeRole(getDb(), staff, key, change.value);
  return r.ok ? NextResponse.json({ ok: true, version: r.version }) : fail(r.status, r.error);
}

/** Roles are never deleted (history and audit refer to them). Disable a custom role instead; built-in roles cannot be removed. */
export async function DELETE(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ error: "Roles cannot be deleted. Disable a custom role instead; built-in roles cannot be removed." }, { status: 405, headers: { allow: "POST" } });
}
