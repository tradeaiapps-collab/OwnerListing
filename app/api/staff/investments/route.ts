import { NextResponse } from "next/server";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investStaffGate, ok } from "../../../../src/server/investment-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Review queue (full project text) and counts for reports. 404 while the module is off. */
async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  return ok({ items: await deps.repo.listByStatus("pending_review"), counts: await deps.repo.counts() });
}

export const GET = withApi(handleGet);
