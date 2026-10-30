import { NextResponse } from "next/server";
import { parseInviteInput } from "../../../../src/domain/staff-invite";
import { getDb } from "../../../../src/server/context";
import { createInvite, listInvites } from "../../../../src/server/staff-invite-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";
import { notifyAdmins, notifyStaffInvite } from "../../../../src/server/notify";

/** Staff allowlist with history. Admin only (staff.manage). */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ invites: await listInvites(getDb()) });
}

/** Invites an email address with a role. Audited. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const input = parseInviteInput(await readJsonObject(req));
  if (!input.ok) return fail(400, input.error);
  const db = getDb();
  const r = await createInvite(db, staff, input.email, input.role);
  if (r.ok) {
    void notifyStaffInvite(db, input.email, input.role);
    void notifyAdmins(db, "staff_invite_created", `A staff invite with the role "${input.role.replace(/_/g, " ")}" was created.`, { exceptUserId: staff.id });
  }
  return r.ok ? NextResponse.json({ ok: true, id: r.id }, { status: 201 }) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
