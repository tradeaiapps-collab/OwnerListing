import { NextResponse } from "next/server";
import { DEMAND_NOTE, demandOutlook } from "../../../../src/domain/market-forecast";
import { getDb } from "../../../../src/server/context";
import { loadDemandFacts } from "../../../../src/server/market-intel-db";
import { loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

/** Buyer demand outlook from platform activity (saves, enquiries, offers) in the area. Aggregate counts only, hidden below a minimum. Signed-in users only. */
async function handleGet(req: Request) {
  const p = new URL(req.url).searchParams;
  const ctx = await loadIntel(req, k => p.get(k));
  if (ctx instanceof NextResponse) return ctx;
  const facts = await loadDemandFacts(getDb(), ctx.query, ctx.now).catch(() => undefined);
  return NextResponse.json({ query: ctx.query, demand: facts ? demandOutlook(facts) : { state: "unavailable", message: "Buyer activity is not available right now." }, note: DEMAND_NOTE }, { headers: noStore });
}

export const GET = withApi(handleGet);
