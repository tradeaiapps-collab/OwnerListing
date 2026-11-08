import { NextResponse } from "next/server";
import { requestInspection } from "../../../src/domain/inspection-marketplace";
import { getActor } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { getEnquiryDeps } from "../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../src/server/http";
import { bookingIds, getBookingRepo } from "../../../src/server/inspection-marketplace-db";
import { requireCurrentTerms } from "../../../src/server/terms-guard";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in buyer's own inspection requests with their status. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ bookings: await getBookingRepo().bookingsForBuyer(actor.userId) }, { headers: { "cache-control": "no-store" } });
}

/** Body: { listingId, slots: [ISO start times, 1 to 3], notes? }. A verified buyer asks for an inspection of a published listing; status starts as pending_inspector_response. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const noTerms = await requireCurrentTerms(getEnquiryDeps().termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const body: unknown = await req.json().catch(() => null);
  const listingId = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["listingId"] : undefined;
  const r = await requestInspection(getBookingRepo(), actor, String(listingId ?? ""), body, bookingIds);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
