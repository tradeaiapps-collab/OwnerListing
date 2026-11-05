import { NextResponse } from "next/server";
import type { ListingRecord } from "../../../../../src/domain/listing-service";
import { SELLER_GOALS, SELLER_NOTE, isSellerGoal, pricingAdvice, type SellerGoal } from "../../../../../src/domain/seller-insights";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { requireListingOwner } from "../../../../../src/server/owner-listing";
import { getIntelligenceSource, noStore } from "../../../../../src/server/property-intelligence";
import { getPricingPreference, getSellerInsights, savePricingPreference } from "../../../../../src/server/seller-insights-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const subjectOf = (l: ListingRecord["listing"]) => ({
  transactionType: "sale" as const, propertyType: l.propertyType,
  ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.postcode !== undefined ? { postcode: l.postcode } : {}),
  ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}), ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}),
  ...(l.parking !== undefined ? { parking: l.parking } : {})
});

async function build(req: Request, id: string, goal: SellerGoal | undefined, save: boolean) {
  const owner = await requireListingOwner(req, id);
  if (owner instanceof NextResponse) return owner;
  const l = owner.rec.listing;
  if (l.transactionType !== "sale") return NextResponse.json({ error: "Pricing advice is for properties for sale." }, { status: 400, headers: noStore });
  if (!l.suburb && !l.postcode) return NextResponse.json({ error: "Add a suburb or postcode to the listing to see market insights." }, { status: 400, headers: noStore });
  const db = getDb(), now = getDeps().now(), subject = subjectOf(l);
  const stored = await getPricingPreference(db, id);
  const chosen = goal ?? stored?.goal ?? "balanced";
  let comps: Awaited<ReturnType<ReturnType<typeof getIntelligenceSource>["find"]>> | undefined;
  const load = async () => (comps ??= await getIntelligenceSource(db).find(subject, now).catch(() => []));
  const insights = await getSellerInsights(db, subject, now, load);
  const advice = pricingAdvice(chosen, subject, await load(), now);
  if (save) await savePricingPreference(db, id, chosen, advice.state === "ready" ? advice : undefined, now);
  const preference = save ? { goal: chosen, ...(advice.state === "ready" ? { recommendedCents: advice.recommendedCents, rationale: advice.rationale } : {}), updatedAt: now } : stored;
  return NextResponse.json({ goal: chosen, goals: SELLER_GOALS, advice, preference, askingCents: l.priceCents ?? null, ...insights, note: SELLER_NOTE }, { headers: noStore });
}

/** The listing owner's market view and pricing advice for their saved goal (balanced when none). Owner only; everyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  return build(req, (await params).id, undefined, false);
}

/** Saves the seller's goal ("fast_sale", "max_price" or "balanced") and returns the advice for it. Rules only; the seller sets the price. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const body = await req.json().catch(() => ({})) as { goal?: unknown };
  if (!isSellerGoal(body.goal)) return NextResponse.json({ error: "Choose fast_sale, max_price or balanced." }, { status: 400, headers: noStore });
  return build(req, (await params).id, body.goal, true);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
