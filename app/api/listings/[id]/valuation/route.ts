import { NextResponse } from "next/server";
import { getListing } from "../../../../../src/domain/listing-service";
import { windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { valuationVisible } from "../../../../../src/domain/valuation";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { INTEL_RATE } from "../../../../../src/domain/property-intelligence";
import { noStore } from "../../../../../src/server/property-intelligence";
import { getOverride, getValuationSettings } from "../../../../../src/server/valuation-db";
import { buildValuation } from "../../../../../src/server/valuation-service";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The buyer's valuation for a published sale listing. Signed-in users only (the figures are advisory and scraping them is not allowed),
 * limited per user per hour (fails closed). 404 while valuations are off for the site or this listing, so the page shows no card.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const actor = await getActor(req).catch(() => null);
  if (!actor) return NextResponse.json({ error: "Sign in to see the valuation." }, { status: 401, headers: noStore });
  const db = getDb(), deps = getDeps();
  const settings = await getValuationSettings(db);
  const hidden = () => NextResponse.json({ error: "Valuation not available." }, { status: 404, headers: noStore });
  if (!settings.enabled) return hidden();
  const r = await getListing(deps, actor, id);
  if (!r.ok) return hidden();
  const override = await getOverride(db, id).catch(() => undefined);
  if (!valuationVisible(settings, override)) return hidden();
  const now = deps.now();
  let hits: number | undefined;
  try { hits = await countHitPg(db, `valuation:${actor.userId}`, windowStart(now, INTEL_RATE.windowMs)); } catch { hits = undefined; }
  if (!withinLimit(hits, INTEL_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { ...noStore, "Retry-After": "600" } });
  return NextResponse.json({ valuation: await buildValuation(db, r.value, settings, now) }, { headers: noStore });
}

export const GET = withApi(handleGet);
