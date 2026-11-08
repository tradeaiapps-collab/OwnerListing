import { NextResponse } from "next/server";
import { cancelBooking } from "../../../../../src/domain/inspection-marketplace";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { bookingIds, getBookingRepo } from "../../../../../src/server/inspection-marketplace-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The buyer withdraws their request (and the accepted inspection with it) unless the report is already finished. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await cancelBooking(getBookingRepo(), actor, id, bookingIds);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
