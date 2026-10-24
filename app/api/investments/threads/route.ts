import { NextResponse } from "next/server";
import { threads } from "../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate, ok } from "../../../../src/server/investment-route";

export async function GET(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  return ok({ items: await threads(deps, actor) });
}
