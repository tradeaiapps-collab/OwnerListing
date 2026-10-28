import { NextResponse } from "next/server";
import { myFees } from "../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate, ok } from "../../../../src/server/investment-route";
import { withApi } from "../../../../src/server/api/with-api";

/** The poster's own platform fee notices (Model 1). Invoiced to the poster; never taken from investor money. */
async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  return ok({ items: (await myFees(deps, actor)).map(({ ownerUserId: _o, ...f }) => f) });
}

export const GET = withApi(handleGet);
