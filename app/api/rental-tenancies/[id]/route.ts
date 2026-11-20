import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { endTenancy } from "../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Ends a tenancy (the person can no longer send repair requests). Only the listing's owner. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await endTenancy(getDb(), actor.userId, id);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
