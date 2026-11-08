import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { riskDashboard } from "../../../../../src/server/settlement-risk-db";
import { staffAudit, staffGateAny } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Elena's risk ranking of every open settlement, the top 10 at-risk deals and the fall-through record. Re-scores on the way. Listing titles only. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["report.sales", "report.operations"]);
  if (staff instanceof NextResponse) return staff;
  const d = await riskDashboard(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.settlement_risk_viewed", { returned: d.rows.length, high: d.totals.high });
  return NextResponse.json(d, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
