import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { reviewQueuePg } from "../../../../src/server/disclosure-config-db";
import { staffAudit, staffGate } from "../../../../src/server/staff-route";

/** Owner disclosure submissions waiting for Compliance, oldest first. */
export async function GET(req: Request) {
  const staff = await staffGate(req, "disclosure.verify");
  if (staff instanceof NextResponse) return staff;
  const queue = await reviewQueuePg(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.disclosure_queue_viewed", { returned: queue.length });
  return NextResponse.json({ queue }, { headers: { "cache-control": "no-store" } });
}
