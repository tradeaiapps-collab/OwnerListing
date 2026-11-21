import { NextResponse } from "next/server";
import { answerElena, getElenaMatch, resetElena } from "../../../../../src/domain/elena-investor-match-service";
import { getDb } from "../../../../../src/server/context";
import { createPgProfileStore } from "../../../../../src/server/elena-investor-match-db";
import { smallJson } from "../../../../../src/server/elena-projects-route";
import { investGate, invFailure, ok } from "../../../../../src/server/investment-route";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Elena's investor onboarding: GET the next question or the matches, POST one answer { step, value }, DELETE saved preferences. */
async function wire(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  return actor instanceof NextResponse ? actor : { deps, actor, store: createPgProfileStore(getDb()) };
}
export const GET = withApi(async (req: Request) => {
  const g = await wire(req);
  if (g instanceof NextResponse) return g;
  const r = await getElenaMatch(g.deps, g.store, g.actor);
  return r.ok ? ok(r.value) : invFailure(r);
});
export const POST = withApi(async (req: Request) => {
  const g = await wire(req);
  if (g instanceof NextResponse) return g;
  const r = await answerElena(g.deps, g.store, g.actor, await smallJson(req));
  return r.ok ? ok(r.value) : invFailure(r);
});
export const DELETE = withApi(async (req: Request) => {
  const g = await wire(req);
  if (g instanceof NextResponse) return g;
  const r = await resetElena(g.deps, g.store, g.actor);
  return r.ok ? ok(r.value) : invFailure(r);
});
