import { NextResponse } from "next/server";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { bookSlot, bookableTimes, threadLogForOwner } from "../../../../../src/server/elena-enquiries-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = { ok: false, code: "not_found", message: "Not found." } as const;

/** What Elena adds to one thread. The buyer sees the inspection times they can book; the listing's owner sees her log of this thread. Others get 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(NOT_FOUND);
  const now = new Date().toISOString();
  const [times, log] = await Promise.all([bookableTimes(getDb(), actor.userId, id, now), threadLogForOwner(getDb(), actor.userId, id)]);
  if (!times.enabled && log.length === 0) return NextResponse.json({ buyer: { enabled: false, slots: [] }, log: [] });
  return NextResponse.json({ buyer: times, log });
}

/** The buyer books a time. Body: { "startsAt": "ISO time" }. It must be one of the owner's free inspection times. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return failure({ ok: false, code: "forbidden", message: "Sign in as the buyer to book." });
  const noTerms = await requireCurrentTerms(getEnquiryDeps().termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const { id } = await params;
  if (!isUuid(id)) return failure(NOT_FOUND);
  const b = (await req.json().catch(() => null)) as { startsAt?: unknown } | null;
  const r = await bookSlot(getDb(), actor.userId, id, b?.startsAt, new Date().toISOString());
  return r.ok ? NextResponse.json({ ok: true, bookingId: r.bookingId }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
