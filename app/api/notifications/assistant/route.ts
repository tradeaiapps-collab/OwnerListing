import { NextResponse } from "next/server";
import { ELENA_NOTE, answerNotificationQuestion, describeSuggestions, suggestPreferences, summarizeNotifications } from "../../../../src/domain/notifications";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { categoryStatsPg, getPreferencesPg, listNotificationsPg, recipientPg } from "../../../../src/server/notifications-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Elena for notifications. Body: { action: "summary" | "ask" | "suggest", question? }.
 * Rule based and self-hosted; reads only the signed-in user's own notification data and changes nothing.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { action?: unknown; question?: unknown } | null;
  const db = getDb();
  let reply;
  if (b?.action === "summary") reply = summarizeNotifications((await listNotificationsPg(db, actor.userId, "inbox", 50)).items);
  else if (b?.action === "suggest") {
    const [stats, prefs, to] = await Promise.all([categoryStatsPg(db, actor.userId), getPreferencesPg(db, actor.userId), recipientPg(db, actor.userId)]);
    const suggestions = suggestPreferences(stats, prefs, to.phone !== null);
    return NextResponse.json({ reply: describeSuggestions(suggestions), suggestions, note: ELENA_NOTE });
  } else if (b?.action === "ask" && typeof b.question === "string") reply = answerNotificationQuestion(b.question);
  else return NextResponse.json({ error: "Send { action: \"summary\" | \"ask\" | \"suggest\" } (ask needs a question)." }, { status: 400 });
  return NextResponse.json({ reply, note: ELENA_NOTE });
}

export const POST = withApi(handlePost);
