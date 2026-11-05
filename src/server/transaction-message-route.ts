import { NextResponse } from "next/server";
import { effectivePermissions } from "../domain/staff-access";
import { isUuid, parseAction } from "../domain/transaction-messages";
import { getActor, getDb, getStaff } from "./context";
import { csrfGuard } from "./csrf";
import { unauthenticated } from "./http";
import { inbox, markRead, sendMessage, setArchived, setMuted, threadMessages, type Viewer } from "./transaction-message-db";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const NO_STORE = { "cache-control": "no-store" };

/** Staff are checked first (team channels), then ordinary signed-in people (their own deals). The seat is always worked out from the database. */
async function who(req: Request): Promise<{ userId: string; viewer: Viewer } | null> {
  const staff = await getStaff(req);
  if (staff) return { userId: staff.id, viewer: { staffPermissions: effectivePermissions(staff) } };
  const actor = await getActor(req);
  return actor ? { userId: actor.userId, viewer: { staffPermissions: null } } : null;
}

/** GET /api/messages: the inbox, deals first by recency and (for staff) the team channels, with unread counts. */
export async function inboxGet(req: Request) {
  const w = await who(req);
  if (!w) return unauthenticated();
  return NextResponse.json(await inbox(getDb(), w.userId, w.viewer), { headers: NO_STORE });
}

/** GET /api/messages/[id]: one conversation, oldest first. Does not mark it read; the page posts { action: "read" } once shown. */
export async function threadGet(req: Request, id: string) {
  const w = await who(req);
  if (!w) return unauthenticated();
  if (!isUuid(id)) return fail(404, "Conversation not found.");
  const r = await threadMessages(getDb(), w.userId, id, w.viewer);
  return r.ok ? NextResponse.json(r.value, { headers: NO_STORE }) : fail(r.status, r.error);
}

/** POST /api/messages/[id] { body, replyToId? } sends; { action: "read" | "mute" | "archive" } manages. */
export async function threadPost(req: Request, id: string) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const w = await who(req);
  if (!w) return unauthenticated();
  if (!isUuid(id)) return fail(404, "Conversation not found.");
  const raw: unknown = await req.json().catch(() => null);
  const a = parseAction(raw);
  if (!a.ok) return fail(400, a.error);
  const db = getDb(), v = a.value;
  const r = v.action === "send" ? await sendMessage(db, w.userId, id, v.send, process.env, w.viewer)
    : v.action === "read" ? await markRead(db, w.userId, id, w.viewer)
    : v.action === "mute" ? await setMuted(db, w.userId, id, v.muted, w.viewer)
    : await setArchived(db, w.userId, id, v.archived, w.viewer);
  return r.ok ? NextResponse.json(r.value, { status: v.action === "send" ? 201 : 200 }) : fail(r.status, r.error);
}
