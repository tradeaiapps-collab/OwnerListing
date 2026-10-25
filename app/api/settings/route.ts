import { NextResponse } from "next/server";
import { parseSettingsInput } from "../../../src/domain/account-settings";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";
import { getSettingsPg, saveSettingsPg } from "../../../src/server/terms-db";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in user's own language and time zone (defaults: en-AU, Australia/Sydney). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ settings: await getSettingsPg(getDb(), actor.userId) });
}

/** Body: { locale, timeZone }. Always saved for the signed-in user; no user id is accepted from the client. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseSettingsInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  await saveSettingsPg(getDb(), actor.userId, parsed.value);
  return NextResponse.json({ settings: parsed.value });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
