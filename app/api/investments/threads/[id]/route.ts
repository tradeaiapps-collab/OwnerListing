import { NextResponse } from "next/server";
import { getThread, postMessage } from "../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../src/server/investment-route";
import { withApi } from "../../../../../src/server/api/with-api";

// Only GET and POST on purpose: messages are never edited or deleted (CLAUDE.md).

async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await getThread(deps, actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

async function handlePost(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await postMessage(deps, actor, id, await req.json().catch(() => null));
  return r.ok ? ok({ message: r.value }, 201) : invFailure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
