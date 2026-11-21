import { NextResponse } from "next/server";
import { buildPortfolio } from "../../../../src/domain/investor-portfolio";
import { elenaGate, invFailure } from "../../../../src/server/elena-projects-route";
import { ok } from "../../../../src/server/investment-route";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in investor's portfolio: projects they follow or registered interest in, with documents, updates and Q&A status. Read only. */
async function handleGet(req: Request) {
  const g = await elenaGate(req, []);
  if (g instanceof NextResponse) return g;
  const r = await buildPortfolio(g.deps, g.store, g.docs, g.actor);
  return r.ok ? ok(r.value) : invFailure(r);
}

export const GET = withApi(handleGet);
