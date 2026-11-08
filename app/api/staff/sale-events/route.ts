import { NextResponse } from "next/server";
import { parseManualSaleEvent, SALE_EVENT_TYPES, type SaleEventType } from "../../../../src/domain/sale-events";
import { staffCan } from "../../../../src/domain/staff-access";
import { reasonOk } from "../../../../src/domain/staff-admin";
import { getDb, getDeps } from "../../../../src/server/context";
import { backfillAcceptedOfferEventsPg, listSaleEventsPg, recordManualEventPg, type SaleEventFilters } from "../../../../src/server/sale-events-db";
import { fail, readJsonObject, staffAudit, staffGate, staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** The sold and rented log: ?type=sold|rented &status=active|voided|all &origin=accepted_offer|staff_manual &q (address, suburb, postcode, event or offer id) &cursor. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["sale_event.manage", "report.sales"]);
  if (staff instanceof NextResponse) return staff;
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k)?.trim().slice(0, 120) || undefined;
  const type = SALE_EVENT_TYPES.find(t => t === get("type")) as SaleEventType | undefined;
  const status = (["active", "voided", "all"] as const).find(s => s === get("status")) ?? "active";
  const origin = (["accepted_offer", "staff_manual"] as const).find(o => o === get("origin"));
  const q = get("q"), cursor = get("cursor");
  const filters: SaleEventFilters = { status, ...(type ? { type } : {}), ...(origin ? { origin } : {}), ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
  const page = await listSaleEventsPg(getDb(), filters, staffCan(staff, "pii.view_full"));
  await staffAudit(staff, "staff_session", staff.id, "staff.sale_events_viewed", { ...filters, returned: page.rows.length });
  return NextResponse.json(
    { events: page.rows, nextCursor: page.nextCursor, canManage: staffCan(staff, "sale_event.manage") },
    { headers: { "cache-control": "no-store" } }
  );
}

/**
 * Add a historical sale or rental (body: eventType, amountCents, occurredAt, source, address, state, suburb, postcode, propertyType,
 * optional bedrooms, bathrooms, carSpaces, landAreaSqm, counterparty, note, plus a reason of 10 to 1000 characters),
 * or { action: "sweep", reason } to write events for accepted offers that have none.
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "sale_event.manage");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON body.");
  if (!reasonOk(b["reason"]) || (b["reason"] as string).trim().length > 1000) return fail(400, "Give a reason of 10 to 1000 characters.");
  const reason = (b["reason"] as string).trim();
  if (b["action"] === "sweep") {
    const r = await backfillAcceptedOfferEventsPg(getDb());
    await staffAudit(staff, "staff_session", staff.id, "staff.sale_events_swept", { ...r, reason });
    return NextResponse.json({ ok: true, ...r });
  }
  const parsed = parseManualSaleEvent(b, getDeps().now());
  if (!parsed.ok) return fail(400, parsed.error);
  const id = await recordManualEventPg(getDb(), parsed.value, staff.id);
  await staffAudit(staff, "property_event", id, "staff.sale_event_recorded", {
    reason, eventType: parsed.value.eventType, amountCents: parsed.value.amountCents, occurredAt: parsed.value.occurredAt, source: parsed.value.source,
    suburb: parsed.value.suburb, postcode: parsed.value.postcode
  });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
