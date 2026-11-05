import { NextResponse } from "next/server";
import { CATEGORIES, CATEGORY_INFO } from "../../../../src/domain/notifications";
import { PUSH_LOCKED_ON, parsePushPreferencesInput } from "../../../../src/domain/push";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getPushPreferencesPg, savePushPreferencesPg } from "../../../../src/server/push-db";
import { withApi } from "../../../../src/server/api/with-api";

const topics = CATEGORIES.map(c => ({ category: c, label: CATEGORY_INFO[c].label, text: CATEGORY_INFO[c].text, locked: PUSH_LOCKED_ON.includes(c) }));

async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ topics: await getPushPreferencesPg(getDb(), actor.userId), catalogue: topics });
}

/** Body: { topics: { <category>: boolean } }. Each change is logged as consent. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parsePushPreferencesInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  return NextResponse.json({ topics: await savePushPreferencesPg(getDb(), actor.userId, parsed.value) });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
