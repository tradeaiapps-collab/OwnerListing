import { NextResponse } from "next/server";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investStaffGate, ok } from "../../../../../src/server/investment-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Every platform fee (Model 1), newest first. Marking needs investment.manage. */
async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.manage");
  if (staff instanceof NextResponse) return staff;
  return ok({ items: await deps.repo.listFees({}) });
}

export const GET = withApi(handleGet);
