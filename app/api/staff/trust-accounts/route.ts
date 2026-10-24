import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { listTrustQueue } from "../../../../src/server/staff-admin-db";
import { staffAudit, staffGate } from "../../../../src/server/staff-route";

/** Trust account checks waiting for a person, with the verification evidence. The account number is never returned. */
export async function GET(req: Request) {
  const staff = await staffGate(req, "trust_account.approve");
  if (staff instanceof NextResponse) return staff;
  const checks = await listTrustQueue(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.trust_queue_viewed", { returned: checks.length });
  return NextResponse.json({ checks, me: staff.id });
}
