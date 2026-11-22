import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { createRentalSender, startTenancy } from "../../../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { applicationId } for an approved application, or { email } of a person who already has an account. Only the listing's owner. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const db = getDb();
  const r = await startTenancy(db, createRentalSender(db), actor.userId, id, await req.json().catch(() => null), new Date().toISOString());
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
