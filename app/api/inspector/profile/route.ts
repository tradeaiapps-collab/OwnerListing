import { NextResponse } from "next/server";
import { applyAsInspector } from "../../../../src/domain/inspection-marketplace";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { bookingIds, getBookingRepo } from "../../../../src/server/inspection-marketplace-db";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in user's inspector profile, or null when they have not applied. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ profile: (await getBookingRepo().profile(actor.userId)) ?? null }, { headers: { "cache-control": "no-store" } });
}

/** Body: { businessName, licenceRef?, jurisdictions: ["NSW", ...] }. Starts as pending until staff approve it at /staff/inspections. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await applyAsInspector(getBookingRepo(), actor, await req.json().catch(() => null), bookingIds);
  return r.ok ? NextResponse.json({ ok: true }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
