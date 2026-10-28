import { NextResponse } from "next/server";
import { decideContract } from "../../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { readJsonObject } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/** { action: confirm | reject, reason, contractAmountCents? }. Confirm sets "contract returned"; Model 1 then makes the fee due. */
async function handlePost(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const b = await readJsonObject(req);
  const r = await decideContract(deps, staff, id, b?.["action"], b?.["reason"], b?.["contractAmountCents"]);
  return r.ok ? ok(r.value) : invFailure(r);
}

export const POST = withApi(handlePost);
