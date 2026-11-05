import { NextResponse } from "next/server";
import { getActor } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";
import { bookInspection, repo } from "../../../src/server/open-inspection-service";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in buyer's own open inspection bookings (upcoming first, then past) and the account details the booking form starts with. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const [bookings, profile] = await Promise.all([repo().buyerBookings(actor.userId), repo().profile(actor.userId)]);
  return NextResponse.json({ bookings, profile }, { headers: { "cache-control": "no-store" } });
}

/** Body: { listingId, startsAt, name, phone?, email?, notes? }. Books one free slot on a published listing. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await bookInspection(repo(), actor, await req.json().catch(() => null), new Date().toISOString());
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
