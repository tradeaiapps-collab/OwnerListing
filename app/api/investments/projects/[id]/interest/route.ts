import { NextResponse } from "next/server";
import { expressInterest } from "../../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";

/** Non-binding interest: { message, amountMinCents, amountMaxCents }. Opens the conversation with the owner. No commitment is recorded. */
export async function POST(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await expressInterest(deps, actor, id, await req.json().catch(() => null));
  return r.ok ? ok({ interest: r.value }, 201) : invFailure(r);
}
