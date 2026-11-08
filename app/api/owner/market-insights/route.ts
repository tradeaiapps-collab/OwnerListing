import { NextResponse } from "next/server";
import { INTEL_RATE, parseIntelQuery } from "../../../../src/domain/property-intelligence";
import { windowStart, withinLimit } from "../../../../src/domain/rate-limit";
import { getActor, getDb, getDeps } from "../../../../src/server/context";
import { countHitPg } from "../../../../src/server/offer-flow-db";
import { getIntelligenceSource, noStore } from "../../../../src/server/property-intelligence";
import { getSellerInsights } from "../../../../src/server/seller-insights-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Seller market insights for an area: comparable sales (90 days), monthly price trend, days on the market and the price-to-days guide.
 * Signed-in users only, same hourly limit as the other intelligence routes (fails closed). Advisory; see SELLER_NOTE. Sales only.
 */
async function handleGet(req: Request) {
  const actor = await getActor(req).catch(() => null);
  if (!actor) return NextResponse.json({ error: "Sign in to see market insights." }, { status: 401, headers: noStore });
  const p = new URL(req.url).searchParams;
  const parsed = parseIntelQuery(k => (k === "transactionType" ? "sale" : p.get(k)));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: noStore });
  const db = getDb(), now = getDeps().now();
  let hits: number | undefined;
  try { hits = await countHitPg(db, `intel:${actor.userId}`, windowStart(now, INTEL_RATE.windowMs)); } catch { hits = undefined; }
  if (!withinLimit(hits, INTEL_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { ...noStore, "Retry-After": "600" } });
  const q = parsed.query;
  const insights = await getSellerInsights(db, q, now, () => getIntelligenceSource(db).find(q, now).catch(() => []));
  return NextResponse.json({ query: q, ...insights }, { headers: noStore });
}

export const GET = withApi(handleGet);
