import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { removeTime, repo } from "../../../../../../src/server/open-inspection-service";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/** Takes a published open time (`?kind=rule`) or a blocked time (`?kind=block`) off the calendar. Bookings already made are not touched; cancel those from the inspection calendar. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, itemId } = await params;
  const r = await removeTime(repo(), actor, id, new URL(req.url).searchParams.get("kind") ?? "rule", itemId);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const DELETE = withApi(handleDelete);
