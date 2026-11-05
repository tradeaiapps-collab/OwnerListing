import { NextResponse } from "next/server";
import { acceptBooking, passBooking } from "../../../../../src/domain/inspection-marketplace";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { bookingIds, getBookingRepo } from "../../../../../src/server/inspection-marketplace-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { action: "accept", slot } or { action: "pass" }. Accepting creates the inspection the report workflow continues on. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (o["action"] === "accept") {
    const r = await acceptBooking(getBookingRepo(), actor, id, o["slot"], bookingIds);
    return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
  }
  if (o["action"] === "pass") {
    const r = await passBooking(getBookingRepo(), actor, id, bookingIds);
    return r.ok ? NextResponse.json({ ok: true }) : failure(r);
  }
  return failure({ ok: false, code: "invalid", message: "Unknown action." });
}

export const POST = withApi(handlePost);
