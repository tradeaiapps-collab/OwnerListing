import { NextResponse } from "next/server";
import { getDb } from "../../../../../../src/server/context";
import { staffRiskDetail } from "../../../../../../src/server/settlement-risk-db";
import { fail, staffAudit, staffGateAny, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** One settlement's risk score, factors and recommended actions. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGateAny(req, ["report.sales", "report.operations"]);
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Settlement not found.");
  const r = await staffRiskDetail(getDb(), id);
  if (!r.ok) return fail(r.status, r.error);
  await staffAudit(staff, "settlement", id, "staff.settlement_risk_detail_viewed", { score: r.value.score });
  return NextResponse.json(r.value, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
