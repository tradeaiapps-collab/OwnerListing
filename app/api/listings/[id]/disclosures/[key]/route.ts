import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { itemsFor, parseSubmission } from "../../../../../../src/domain/disclosure-config";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { activeListingDocumentPg, approvedVersionPg, submitDisclosurePg } from "../../../../../../src/server/disclosure-config-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; key: string }> };
const fail = (status: number, error: string, code?: string) => NextResponse.json({ error, ...(code ? { code } : {}) }, { status });

/**
 * Owner (or appointed agent) answers one required disclosure: { evidenceDocumentId } (an active document on this listing) or
 * { notApplicable: true, note } where the item allows it. The answer waits for Compliance; it never satisfies the item by itself.
 * Only while the listing is a draft or pending review.
 */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id, key } = await params;
  const handler = await requireListingHandler(req, id, "listing.describe");
  if (handler instanceof NextResponse) return handler;
  const l = handler.rec.listing;
  if (l.status !== "draft" && l.status !== "pending_review") return fail(409, "Disclosures can only be changed before the listing is published.");
  const db = getDb();
  const version = await approvedVersionPg(db, l.jurisdiction, l.transactionType, l.useClass);
  if (!version) return fail(423, "Publishing is not available yet for this state.", "region_not_enabled");
  const item = itemsFor(version.items, l.propertyType).find(i => i.key === key);
  if (!item) return fail(404, "This disclosure is not required for this listing.");
  const parsed = parseSubmission(await req.json().catch(() => null), item);
  if (!parsed.ok) return fail(400, parsed.message);
  if (parsed.value.kind === "evidence" && !(await activeListingDocumentPg(db, id, parsed.value.documentId))) {
    return fail(400, "Choose a document uploaded to this listing.");
  }
  await submitDisclosurePg(db, { listingId: id, jurisdiction: l.jurisdiction, key, versionId: version.id, actorId: handler.actor.userId, input: parsed.value });
  const deps = getDeps();
  await deps.appendAudit({
    id: randomUUID(), occurredAt: deps.now(), actorType: "user", actorId: handler.actor.userId, aggregateType: "listing", aggregateId: id,
    eventType: "listing.disclosure_submitted", correlationId: randomUUID(),
    payload: { key, versionId: version.id, notApplicable: parsed.value.kind === "not_applicable", asAgent: handler.asAgent }
  });
  return NextResponse.json({ ok: true, state: "submitted" });
}

export const PUT = withApi(handlePut);
