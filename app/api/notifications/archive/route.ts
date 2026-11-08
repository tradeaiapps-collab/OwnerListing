import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { archivePg, unreadCountPg } from "../../../../src/server/notifications-db";
import { withApi } from "../../../../src/server/api/with-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body: { ids: string[] (1 to 50) } or { all: true }. Only the signed-in user's own notifications can change. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { ids?: unknown; all?: unknown } | null;
  const all = b?.all === true;
  const ids = Array.isArray(b?.ids) ? b.ids : null;
  if (!all && !(ids && ids.length >= 1 && ids.length <= 50 && ids.every(i => typeof i === "string" && UUID.test(i))))
    return NextResponse.json({ error: "Send { ids: [1 to 50 ids] } or { all: true }." }, { status: 400 });
  const changed = await archivePg(getDb(), actor.userId, all ? "all_read" : (ids as string[]));
  return NextResponse.json({ changed, unread: await unreadCountPg(getDb(), actor.userId) });
}

export const POST = withApi(handlePost);
