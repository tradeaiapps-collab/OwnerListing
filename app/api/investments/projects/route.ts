import { NextResponse } from "next/server";
import { browse, createProject } from "../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate, invFailure, ok } from "../../../../src/server/investment-route";
import { withCovers } from "../../../../src/server/project-covers";

/** Approved projects this investor may see (verified, declared, visibility allows). */
export async function GET(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const r = await browse(deps, actor);
  return r.ok ? ok({ items: await withCovers(r.value) }) : invFailure(r);
}

/** A verified owner submits a project. It goes to staff review; nothing is public until approved. */
export async function POST(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const r = await createProject(deps, actor, await req.json().catch(() => null));
  return r.ok ? ok(r.value, 201) : invFailure(r);
}
