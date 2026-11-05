import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { unauthenticated } from "../../../src/server/http";
import { deleteHistoryPg, listNotificationsPg, parseCursor, unreadCountPg } from "../../../src/server/notifications-db";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in user's own notifications. ?status=inbox|history, ?limit=1..50, ?before=<cursor from nextBefore>. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const q = new URL(req.url).searchParams;
  const status = q.get("status") === "history" ? "history" : "inbox";
  const page = await listNotificationsPg(getDb(), actor.userId, status, Number(q.get("limit") ?? 20), parseCursor(q.get("before")));
  return NextResponse.json({ notifications: page.items, nextBefore: page.nextBefore, unread: await unreadCountPg(getDb(), actor.userId) });
}

/** Deletes the user's own history (archived notifications). */
async function handleDelete(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ deleted: await deleteHistoryPg(getDb(), actor.userId) });
}

export const GET = withApi(handleGet);
export const DELETE = withApi(handleDelete);
