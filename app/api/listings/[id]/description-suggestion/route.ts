import { NextResponse } from "next/server";
import { MAX_OWNER_NOTES, suggestDescription } from "../../../../../src/domain/ai-description";
import { AI_DESCRIPTION_RATE, withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { getAiEngine } from "../../../../../src/server/ai";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner (or appointed agent) asks for an AI draft description. Body: { notes?: string } (up to 1000 characters, sent fenced as data).
 * Returns the draft only: nothing is saved or published, and the screen labels it "AI suggestion, check before publishing".
 * AI off, busy or failing = { state: "unavailable" } with status 200, so the page never breaks. Rate limited per user (fail closed).
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const id = (await params).id;
  const handler = await requireListingHandler(req, id, "listing.describe");
  if (handler instanceof NextResponse) return handler;
  const body: unknown = await req.json().catch(() => null);
  const notes = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["notes"] : undefined;
  if (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_OWNER_NOTES)) {
    return NextResponse.json({ error: `Notes must be text of up to ${MAX_OWNER_NOTES} characters.` }, { status: 400 });
  }
  const hits = await countHitPg(getDb(), `ai-desc:${handler.actor.userId}`, windowStart(new Date().toISOString(), AI_DESCRIPTION_RATE.windowMs));
  if (!withinLimit(hits, AI_DESCRIPTION_RATE.perUser)) return NextResponse.json({ error: "Too many suggestions. Try again later." }, { status: 429 });
  const l = handler.rec.listing;
  const result = await suggestDescription(await getAiEngine(), {
    transactionType: l.transactionType, propertyType: l.propertyType, title: l.title,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}),
    ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}), ...(l.parking !== undefined ? { parking: l.parking } : {})
  }, notes ?? "");
  if (result.state === "unavailable") console.warn(`[ai-description] listing ${id}: unavailable (${result.reason})`);
  const deps = getDeps();
  await deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: handler.actor.userId,
    aggregateType: "listing", aggregateId: id, eventType: "listing.ai_description_requested",
    correlationId: deps.newId(), payload: { aiState: result.state, ...(result.state === "unavailable" ? { reason: result.reason } : {}) }
  });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
