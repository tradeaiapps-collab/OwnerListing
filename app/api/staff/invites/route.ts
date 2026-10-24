import { NextResponse } from "next/server";
import { parseInviteInput } from "../../../../src/domain/staff-invite";
import { getDb } from "../../../../src/server/context";
import { createInvite, listInvites } from "../../../../src/server/staff-invite-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";

/** Staff allowlist with history. Admin only (staff.manage). */
export async function GET(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ invites: await listInvites(getDb()) });
}

/** Invites an email address with a role. Audited. */
export async function POST(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const input = parseInviteInput(await readJsonObject(req));
  if (!input.ok) return fail(400, input.error);
  const r = await createInvite(getDb(), staff, input.email, input.role);
  return r.ok ? NextResponse.json({ ok: true, id: r.id }, { status: 201 }) : fail(r.status, r.error);
}
