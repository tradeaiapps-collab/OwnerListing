import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { settlementPortfolio } from "../../../../src/server/settlement-db";
import { staffAudit, staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Every settlement, stuck ones first, with totals and a count per stage. Listing titles only. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["report.sales", "report.operations"]);
  if (staff instanceof NextResponse) return staff;
  const p = await settlementPortfolio(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.settlements_viewed", { returned: p.rows.length });
  return NextResponse.json(p, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
