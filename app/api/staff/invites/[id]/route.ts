import { NextResponse } from "next/server";
import { isRoleKey } from "../../../../../src/domain/staff-roles";
import { getDb } from "../../../../../src/server/context";
import { changeInvite } from "../../../../../src/server/staff-invite-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Body { action: "revoke" } or { action: "set_role", role }. Never your own invite, never the last admin, never someone with access you lack,
 * and never a role with access you lack (sensitive roles: super admin only). Audited.
 */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Invite not found.");
  const body = await readJsonObject(req);
  const action = body?.["action"];
  if (action !== "set_role" && action !== "revoke") return fail(400, "Unknown action.");
  const role = body?.["role"];
  if (action === "set_role" && !isRoleKey(role)) return fail(400, "Choose a role.");
  const r = await changeInvite(getDb(), staff, id, action === "set_role" && isRoleKey(role) ? role : null);
  return r.ok ? NextResponse.json({ ok: true }) : fail(r.status, r.error);
}

export const POST = withApi(handlePost);
