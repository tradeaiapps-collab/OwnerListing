import { NextResponse } from "next/server";
import { myProjects } from "../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investGate, ok } from "../../../../../src/server/investment-route";
import { withCovers } from "../../../../../src/server/project-covers";
import { withApi } from "../../../../../src/server/api/with-api";

async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  return ok({ items: await withCovers(await myProjects(deps, actor)) });
}

export const GET = withApi(handleGet);
