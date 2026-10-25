import { NextResponse } from "next/server";
import { buildOverview, OVERVIEW_WINDOW_DAYS } from "../../../../src/domain/admin-dashboard";
import { getDb } from "../../../../src/server/context";
import { loadOverview } from "../../../../src/server/admin-dashboard-db";
import { staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Admin dashboard headline figures. Opens with any dashboard permission; each block is included only if the role allows it. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["report.sales", "report.operations", "listing.moderate", "user.manage"]);
  if (staff instanceof NextResponse) return staff;
  const overview = buildOverview(staff, await loadOverview(getDb(), OVERVIEW_WINDOW_DAYS));
  return NextResponse.json({ overview }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
