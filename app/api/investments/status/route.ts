import { INVESTMENT_DISCLOSURE } from "../../../../src/config/investment-disclosure";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { notFound, ok } from "../../../../src/server/investment-route";

/** 404 unless both keys are on, so the nav shows nothing about investing while the module is off. */
export async function GET() {
  if (!(await getInvestmentDeps().moduleState()).live) return notFound();
  return ok({ live: true, disclosure: INVESTMENT_DISCLOSURE });
}
