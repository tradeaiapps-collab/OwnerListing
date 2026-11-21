import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { bookViewing, cancelViewing, createRentalSender, decideApplication, markAttendance, withdrawApplication } from "../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One person acting on an application. The listing's owner: { action: "shortlist" | "approve" | "decline" | "ask_info" | "attended" | "no_show" }.
 * The applicant: { action: "withdraw" }, { action: "book", slotId } or { action: "cancel_viewing" }. Each action checks the caller's own side; anyone else gets 404.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const b = (await req.json().catch(() => null)) as { action?: unknown; slotId?: unknown } | null;
  const db = getDb(), sender = createRentalSender(db), now = new Date().toISOString();
  const a = b?.action;
  const r = a === "withdraw" ? await withdrawApplication(db, actor.userId, id)
    : a === "book" ? await bookViewing(db, sender, actor.userId, id, typeof b?.slotId === "string" ? b.slotId : "", now)
    : a === "cancel_viewing" ? await cancelViewing(db, sender, actor.userId, id, now)
    : a === "attended" || a === "no_show" ? await markAttendance(db, actor.userId, id, a === "attended")
    : await decideApplication(db, sender, actor.userId, id, a, now);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
