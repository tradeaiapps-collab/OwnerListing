import { NextResponse } from "next/server";
import { startUpfrontFee } from "../../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Model 2 upfront posting fee: starts the hosted checkout. 503 until the payment provider is connected (no live keys). */
async function handlePost(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps, { json: false });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await startUpfrontFee(deps, actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

export const POST = withApi(handlePost);
