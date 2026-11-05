import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../domain/admin-analytics";
import { addMonths, buildForecastView, HISTORY_MONTHS, parseSegment } from "../domain/market-forecast";
import { localDateInZone } from "../domain/timezone";
import { loadSaleFacts } from "./analytics-suite-db";
import { getDb } from "./context";

/** Shared by the staff and agent forecast routes: ?area=&type= (each "all" or a value). Aggregates only; no single sale is listed. */
export async function forecastResponse(req: Request): Promise<NextResponse> {
  const parsed = parseSegment(new URL(req.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const month = localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE).slice(0, 7);
  const facts = await loadSaleFacts(getDb(), addMonths(month, -(HISTORY_MONTHS - 1)));
  return NextResponse.json({ forecast: buildForecastView(facts, parsed.segment, month) }, { headers: { "cache-control": "no-store" } });
}
