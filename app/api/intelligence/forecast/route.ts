import { NextResponse } from "next/server";
import { forecastTrend, FORECAST_NOTE } from "../../../../src/domain/market-forecast";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

/** Trend forecast: 3, 6 and 12 month outlook for the area's median with an 80% range. Signed-in users only. A statistical extension, see FORECAST_NOTE. */
async function handleGet(req: Request) {
  const p = new URL(req.url).searchParams;
  const ctx = await loadIntel(req, k => p.get(k));
  if (ctx instanceof NextResponse) return ctx;
  const b = buildBundle(ctx.query, ctx.comps, ctx.now);
  return NextResponse.json({ query: b.query, forecast: forecastTrend(b.trend, ctx.query.transactionType), note: FORECAST_NOTE }, { headers: noStore });
}

export const GET = withApi(handleGet);
