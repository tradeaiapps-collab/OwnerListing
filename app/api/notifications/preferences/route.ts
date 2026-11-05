import { NextResponse } from "next/server";
import { CATEGORIES, CATEGORY_INFO, parsePreferencesInput } from "../../../../src/domain/notifications";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getPreferencesPg, recipientPg, savePreferencesPg } from "../../../../src/server/notifications-db";
import { withApi } from "../../../../src/server/api/with-api";

const catalogue = CATEGORIES.map(c => ({ category: c, label: CATEGORY_INFO[c].label, text: CATEGORY_INFO[c].text, locked: CATEGORY_INFO[c].locked, smsAllowed: CATEGORY_INFO[c].smsAllowed }));

async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const [preferences, to] = await Promise.all([getPreferencesPg(getDb(), actor.userId), recipientPg(getDb(), actor.userId)]);
  return NextResponse.json({ preferences, categories: catalogue, phoneVerified: to.phone !== null });
}

/** Body: { preferences: { <category>: { inApp, email, sms } } }. Turning SMS on needs a verified phone number. Each change is logged as consent. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parsePreferencesInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const turningSmsOn = Object.values(parsed.value).some(p => p?.sms);
  if (turningSmsOn && (await recipientPg(getDb(), actor.userId)).phone === null)
    return NextResponse.json({ error: "Verify your phone number before turning on text messages." }, { status: 400 });
  return NextResponse.json({ preferences: await savePreferencesPg(getDb(), actor.userId, parsed.value, "settings") });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
