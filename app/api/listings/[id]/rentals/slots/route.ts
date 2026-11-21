import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { addSlots, createRentalSender } from "../../../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { slots: [{ startsAt (ISO with zone), durationMin?, capacity? }] }. Only the listing's owner. Elena offers new times to applicants who have not booked. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const db = getDb();
  const r = await addSlots(db, createRentalSender(db), actor.userId, id, await req.json().catch(() => null), new Date().toISOString());
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
