import { NextResponse } from "next/server";
import { threads } from "../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate, ok } from "../../../../src/server/investment-route";
import { withApi } from "../../../../src/server/api/with-api";

async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  return ok({ items: await threads(deps, actor) });
}

export const GET = withApi(handleGet);
