import { INVESTMENT_DISCLOSURE } from "../../../../src/config/investment-disclosure";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { notFound, ok } from "../../../../src/server/investment-route";
import { withApi } from "../../../../src/server/api/with-api";

/** 404 unless both keys are on, so the nav shows nothing about investing while the module is off. */
async function handleGet() {
  if (!(await getInvestmentDeps().moduleState()).live) return notFound();
  return ok({ live: true, disclosure: INVESTMENT_DISCLOSURE });
}

export const GET = withApi(handleGet);
