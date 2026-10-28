import { publicBrowse } from "../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { notFound, ok } from "../../../../src/server/investment-route";

/** Approved projects for anyone, signed in or not: the card fields only. 404 while the module is off. */
export async function GET() {
  const deps = getInvestmentDeps();
  if (!(await deps.moduleState()).live) return notFound();
  return ok({ items: await publicBrowse(deps) });
}
