import { NextResponse } from "next/server";
import { sealOfferToken, OfferLinkKeyError } from "../../../../../src/domain/offer-link-crypto";
import { changedFields, floorAad, MANDATE_CONDITIONS, MANDATE_LIMITS, AUTO_MODE_AVAILABLE, parseMandateInput, toMandateView } from "../../../../../src/domain/mandate";
import { appendAuditPg, type Queryable } from "../../../../../src/server/db";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure } from "../../../../../src/server/http";
import { insertMandatePg, mandateHistoryPg } from "../../../../../src/server/mandate-db";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const floorKey = () => process.env["MANDATE_FLOOR_KEY"];
const noStore = { "cache-control": "private, no-store" };

/** The owner edits. An appointed agent edits only with a "full" appointment; with "enquiries_and_offers" they can view. */
async function access(req: Request, id: string) {
  const h = await requireListingHandler(req, id, "offers.view");
  if (h instanceof NextResponse) return h;
  if (!h.asAgent) return { ...h, canEdit: true };
  const appointment = await getDeps().appointmentFor?.(id, h.actor.userId);
  return { ...h, canEdit: appointment?.scope === "full" && !appointment.revoked };
}

/**
 * The listing's negotiation mandate and its version history, for the owner or appointed agent (404 for anyone else).
 * The floor price is never returned: only whether one is set.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const a = await access(req, id);
  if (a instanceof NextResponse) return a;
  const history = await mandateHistoryPg(getDb(), id);
  return NextResponse.json({
    mandate: history[0] ? toMandateView(history[0]) : null,
    history: history.map((v, i) => ({ version: v.version, setBy: v.setBy, createdAt: v.createdAt, changes: changedFields(history[i + 1], v) })),
    canEdit: a.canEdit, asAgent: a.asAgent,
    listing: { title: a.rec.listing.title, address: a.rec.listing.address, transactionType: a.rec.listing.transactionType, ...(a.rec.listing.priceCents !== undefined ? { askingPriceCents: a.rec.listing.priceCents } : {}) },
    options: { conditions: MANDATE_CONDITIONS, limits: MANDATE_LIMITS, autoModeAvailable: AUTO_MODE_AVAILABLE, floorKeyConfigured: !!floorKey() }
  }, { headers: noStore });
}

/**
 * Saves a new mandate version. expectedVersion must be the latest version (0 for the first), so two people editing
 * at once cannot overwrite each other (409). The floor is sealed before storage and kept from the last version when
 * not sent. The audit event is written in the same transaction and never carries prices.
 * Spec: mandate changes need step-up MFA; MFA is not built yet (PROJECT_STATUS.md), so this is session-only for now.
 */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await params;
  const a = await access(req, id);
  if (a instanceof NextResponse) return a;
  if (!a.canEdit) return failure({ ok: false, code: "forbidden", message: "Your appointment lets you view this mandate. Ask the owner for a full appointment to change it." });
  const db = getDb();
  const history = await mandateHistoryPg(db, id);
  const latest = history[0];
  const parsed = parseMandateInput(await req.json().catch(() => null), latest !== undefined);
  if (!parsed.ok) return NextResponse.json({ error: parsed.message, fields: parsed.fields }, { status: 400 });
  const input = parsed.value;
  if (input.expectedVersion !== (latest?.version ?? 0)) {
    return failure({ ok: false, code: "conflict", message: "Someone saved a newer version. Reload to see it, then make your change again." });
  }

  let floorSealed = latest?.floorSealed;
  if (input.floorPriceCents !== undefined) {
    try { floorSealed = await sealOfferToken(String(input.floorPriceCents), floorKey(), floorAad(id)); }
    catch (e) {
      if (e instanceof OfferLinkKeyError) return failure({ ok: false, code: "unavailable", message: "Saving a lowest price is switched off until MANDATE_FLOOR_KEY is set." });
      throw e;
    }
  }
  const { expectedVersion, floorPriceCents: _floor, ...rest } = input;
  const deps = getDeps();
  const now = deps.now();
  const save = async (q: Queryable) => {
    const saved = await insertMandatePg(q, { ...rest, listingId: id, floorSealed: floorSealed!, setBy: a.asAgent ? "agent" : "owner" }, expectedVersion, a.actor.userId, now);
    if (!saved) return undefined;
    await appendAuditPg(q, {
      id: deps.newId(), occurredAt: now, actorType: "user", actorId: a.actor.userId, aggregateType: "negotiation_mandate", aggregateId: id,
      eventType: "mandate.saved", correlationId: deps.newId(),
      payload: { version: saved.version, asAgent: a.asAgent, changes: changedFields(latest, saved) }
    });
    return saved;
  };
  const saved = db.transaction ? await db.transaction(save) : await save(db);
  if (!saved) return failure({ ok: false, code: "conflict", message: "Someone saved a newer version. Reload to see it, then make your change again." });
  return NextResponse.json({ mandate: toMandateView(saved) }, { headers: noStore });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
