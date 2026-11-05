import { NextResponse } from "next/server";
import { parseDigestInput } from "../../../../src/domain/digest";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getDigestSettingsPg, saveDigestSettingsPg } from "../../../../src/server/notification-digest";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in user's own daily digest schedule. Off by default. Body for PUT: { enabled, sendHour (0-23), timezone (IANA name) }. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ digest: await getDigestSettingsPg(getDb(), actor.userId) });
}

async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseDigestInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  return NextResponse.json({ digest: await saveDigestSettingsPg(getDb(), actor.userId, parsed.value) });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
