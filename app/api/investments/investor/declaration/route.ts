import { NextResponse } from "next/server";
import { declare } from "../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investGate, invFailure, ok } from "../../../../../src/server/investment-route";

/** Insert-only investor self-declaration: { category, acknowledgements: {...all true}, disclosureVersion }. */
export async function POST(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const r = await declare(deps, actor, await req.json().catch(() => null));
  return r.ok ? ok({ category: r.value.category }, 201) : invFailure(r);
}
