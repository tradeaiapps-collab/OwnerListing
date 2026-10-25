import { NextResponse } from "next/server";
import { complianceNotes, showPersonal } from "../../../../src/domain/admin-moderation";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb } from "../../../../src/server/context";
import { searchUsers } from "../../../../src/server/admin-moderation-db";
import { staffGate } from "../../../../src/server/staff-route";

/** User accounts with compliance facts: ?q &userType &status &cursor. Names and emails are masked unless the role has pii.view_full. */
export async function GET(req: Request) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k)?.trim().slice(0, 120) || undefined;
  const q = get("q"), userType = get("userType"), status = get("status"), cursor = get("cursor");
  const page = await searchUsers(getDb(), {
    searchPersonal: staffCan(staff, "pii.view_full"),
    ...(q ? { q } : {}), ...(userType ? { userType } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {})
  });
  const users = page.rows.map(({ termsCurrent: _t, ...u }) => ({
    ...u, ...showPersonal(staff, u), notes: complianceNotes(u.userType, { ...u, termsCurrent: true })
  }));
  return NextResponse.json({ users, nextCursor: page.nextCursor, fullDetails: staffCan(staff, "pii.view_full") }, { headers: { "cache-control": "no-store" } });
}
