import { NextResponse } from "next/server";
import { INVESTMENT_DISCLOSURE } from "../../../../src/config/investment-disclosure";
import { investorStatus } from "../../../../src/domain/investment-service";
import { ACK_TEXT } from "../../../../src/domain/investor-projects";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate, invFailure, ok } from "../../../../src/server/investment-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Onboarding state: verification steps, the next step, the declared category, and the text to acknowledge. */
async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const r = await investorStatus(deps, actor);
  return r.ok ? ok({ ...r.value, disclosure: INVESTMENT_DISCLOSURE, acknowledgements: ACK_TEXT }) : invFailure(r);
}

export const GET = withApi(handleGet);
