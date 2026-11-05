import { NextResponse } from "next/server";
import { getDb, getDeps } from "../../../../src/server/context";
import { buildStaffReport } from "../../../../src/server/listing-performance-db";
import { staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Platform listing performance: 30-day totals, rates, median days to first offer and acceptance, and listings that need attention. Staff with report.sales. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await buildStaffReport(getDb(), getDeps().now()), { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
