import { NextResponse } from "next/server";
import { complianceNotes, showPersonal } from "../../../../../src/domain/admin-moderation";
import { getDb } from "../../../../../src/server/context";
import { loadUser } from "../../../../../src/server/admin-moderation-db";
import { hasCurrentTermsPg } from "../../../../../src/server/terms-db";
import { fail, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** One account: compliance facts, what still needs attention and its suspension history. Every view is logged. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Account not found.");
  const db = getDb();
  const found = await loadUser(db, id, uid => hasCurrentTermsPg(db, uid, new Date().toISOString()));
  if (!found) return fail(404, "Account not found.");
  await staffAudit(staff, "user", id, "staff.user_viewed", {});
  const u = found.user;
  return NextResponse.json({ user: { ...u, ...showPersonal(staff, u), notes: complianceNotes(u.userType, u) }, history: found.history }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
