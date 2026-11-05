import { NextResponse } from "next/server";
import { isPushEvent } from "../../../../src/domain/push";
import { getDb } from "../../../../src/server/context";
import { recordPushEventPg } from "../../../../src/server/push-db";
import { withApi } from "../../../../src/server/api/with-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The device reports that a push was opened or dismissed. Body: { id, event: "clicked" | "dismissed" }.
 * No sign-in and no CSRF check, because nothing here acts for a signed-in user: the service worker may run with no page open and the mobile apps send no
 * cookie or Origin. The id is the unguessable delivery id from the push itself; it only stamps that one row once, and it reveals nothing.
 */
async function handlePost(req: Request) {
  const b = (await req.json().catch(() => null)) as { id?: unknown; event?: unknown } | null;
  if (typeof b?.id !== "string" || !UUID.test(b.id) || !isPushEvent(b.event)) return NextResponse.json({ error: "Send { id, event: clicked | dismissed }." }, { status: 400 });
  await recordPushEventPg(getDb(), b.id, b.event);
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
