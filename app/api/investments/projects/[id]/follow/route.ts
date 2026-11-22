import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../src/server/api/with-api";
import { setFollow } from "../../../../../../src/domain/elena-projects-service";

/** An investor follows (PUT) or stops following (DELETE) a project, to hear about owner-approved updates. */
async function change(req: Request, ctx: { params: Promise<{ id: string }> }, on: boolean) {
  const { id } = await ctx.params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await setFollow(g.deps, g.store, g.actor, id, on);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const PUT = withApi((req: Request, ctx: { params: Promise<{ id: string }> }) => change(req, ctx, true));
export const DELETE = withApi((req: Request, ctx: { params: Promise<{ id: string }> }) => change(req, ctx, false));
