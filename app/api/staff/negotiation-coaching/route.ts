import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { coachingStatsPg } from "../../../../src/server/settlement-coach-db";
import { staffAudit, staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** How often each Elena suggestion was used or dismissed, and how coached deals ended compared with the rest. Counts only. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["report.sales", "report.operations"]);
  if (staff instanceof NextResponse) return staff;
  const stats = await coachingStatsPg(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.negotiation_coaching_viewed", {});
  return NextResponse.json(stats, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
