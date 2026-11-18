import { NextResponse } from "next/server";
import { parseRates, toRatesView } from "../../../../../src/domain/listing-rates";
import { appendAuditPg } from "../../../../../src/server/db";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getRatesPg, saveRatesPg } from "../../../../../src/server/listing-rates-db";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "Listing not found." }, { status: 404 });

/**
 * The seller's stated council and water rates. Anyone can read them for a published sale listing (what buyers see); for any other
 * status only the owner or appointed agent can (404 for everyone else). Returns { view, rates, editable }; rates is for the form.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const rec = await getDeps().repo.get(id);
  if (!rec || rec.listing.transactionType !== "sale") return notFound();
  const published = rec.listing.status === "published";
  let editable = false;
  if (!published || (await getActor(req))) {
    const h = await requireListingHandler(req, id, "listing.describe");
    if (h instanceof NextResponse) { if (!published) return h; } else editable = true;
  }
  const rates = (await getRatesPg(getDb(), id)) ?? {};
  return NextResponse.json({ view: toRatesView(rates), rates, editable }, { headers: { "cache-control": published && !editable ? "public, max-age=60" : "private, no-store" } });
}

/** Owner (or appointed agent) replaces the rates. Sale listings only. Send {} to clear. Audited without the amounts. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await params;
  const h = await requireListingHandler(req, id, "listing.describe");
  if (h instanceof NextResponse) return h;
  if (h.rec.listing.transactionType !== "sale") return NextResponse.json({ error: "Council and water rates are for sale listings. For a rental, say who pays in the description." }, { status: 422 });
  const deps = getDeps();
  const now = deps.now();
  const parsed = parseRates(await req.json().catch(() => null), now.slice(0, 10));
  if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400 });
  const db = getDb();
  const save = async (q: typeof db) => {
    await saveRatesPg(q, id, parsed.value, h.actor.userId, now);
    await appendAuditPg(q, {
      id: deps.newId(), occurredAt: now, actorType: "user", actorId: h.actor.userId, aggregateType: "property_listing", aggregateId: id,
      eventType: "listing.rates_saved", correlationId: deps.newId(), payload: { asAgent: h.asAgent, council: !!parsed.value.council, water: !!parsed.value.water }
    });
  };
  if (db.transaction) await db.transaction(save); else await save(db);
  return NextResponse.json({ view: toRatesView(parsed.value), rates: parsed.value, editable: true }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
