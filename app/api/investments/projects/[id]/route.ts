import { NextResponse } from "next/server";
import { editProject, viewProject } from "../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../src/server/investment-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** The owner (any status) or an investor allowed to see it (approved only). Everyone else: 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await viewProject(deps, actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

/** Owner edit (full replacement). Returns the project to staff review. */
async function handlePut(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await editProject(deps, actor, id, await req.json().catch(() => null));
  return r.ok ? ok(r.value) : invFailure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
