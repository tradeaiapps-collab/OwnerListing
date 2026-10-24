import { NextResponse } from "next/server";
import { markFee } from "../../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { readJsonObject } from "../../../../../../src/server/staff-route";

/** { status: paid | waived, reason }. Only from "due"; both are final. Payments hook comes later. */
export async function POST(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const b = await readJsonObject(req);
  const r = await markFee(deps, staff, id, b?.["status"], b?.["reason"]);
  return r.ok ? ok({ status: r.value }) : invFailure(r);
}
