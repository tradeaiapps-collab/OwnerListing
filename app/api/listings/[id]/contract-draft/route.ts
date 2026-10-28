import { NextResponse } from "next/server";
import { buildContractDraft, canDraftFrom } from "../../../../../src/domain/contract-draft";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure } from "../../../../../src/server/http";
import { offersForOwnerPg } from "../../../../../src/server/offers-db";
import { requireListingOwner } from "../../../../../src/server/owner-listing";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner previews a contract (sale) or lease DRAFT for one offer, built from a fixed template. Nothing is stored, sent or signed,
 * no AI is involved, and it records no decision on the offer. Others get 404.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await params;
  const owner = await requireListingOwner(req, id);
  if (owner instanceof NextResponse) return owner;
  const body = await req.json().catch(() => null);
  const offerId = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["offerId"] : undefined;
  if (!isUuid(offerId)) return failure({ ok: false, code: "invalid", message: "Choose an offer." });

  const offer = (await offersForOwnerPg(getDb(), id, owner.actor.userId)).find(o => o.id === offerId);
  if (!offer) return failure({ ok: false, code: "not_found", message: "Offer not found." });
  if (!canDraftFrom(offer.status)) return failure({ ok: false, code: "conflict", message: "A draft cannot be made from this offer." });

  const draft = buildContractDraft(owner.rec.listing, offer);
  const deps = getDeps();
  await deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: owner.actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: "contract_draft.previewed",
    correlationId: deps.newId(), payload: { listingId: id, templateVersion: draft.templateVersion }
  });
  return NextResponse.json({ draft });
}

export const POST = withApi(handlePost);
