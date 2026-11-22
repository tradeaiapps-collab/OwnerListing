import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { answerTime, createNotifySender, ownerAction, proposeTime } from "../../../../src/server/elena-jobs-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One person acting on an Elena job. Body: { "action": "propose", "at": "ISO time" } (owner or contractor suggests a time),
 * { "action": "accept" | "reject" } (the other party answers), or the owner's { "action": "stop" | "resume" | "hide_files" | "show_files" }.
 * The signed-in user must be the owner or the contractor on the job; anyone else gets 404.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const b = (await req.json().catch(() => null)) as { action?: unknown; at?: unknown } | null;
  const now = new Date().toISOString();
  const db = getDb();
  const sender = createNotifySender(db);
  const r = b?.action === "propose" ? await proposeTime(db, sender, actor.userId, id, typeof b.at === "string" ? b.at : "", now)
    : b?.action === "accept" || b?.action === "reject" ? await answerTime(db, sender, actor.userId, id, b.action === "accept", now)
    : await ownerAction(db, actor.userId, id, b?.action, now);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
