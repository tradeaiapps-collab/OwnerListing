import { NextResponse } from "next/server";
import { LOCALE_COOKIE, parseSettingsInput } from "../../../src/domain/account-settings";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";
import { getEnabledLocalesPg, getSettingsPg, saveSettingsPg } from "../../../src/server/terms-db";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in user's own language and time zone (defaults: en-AU, Australia/Sydney). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const db = getDb();
  return NextResponse.json({ settings: await getSettingsPg(db, actor.userId), enabledLocales: await getEnabledLocalesPg(db).catch(() => []) });
}

/** Body: { locale, timeZone }. Always saved for the signed-in user; no user id is accepted from the client. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseSettingsInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const db = getDb();
  await saveSettingsPg(db, actor.userId, parsed.value);
  const res = NextResponse.json({ settings: parsed.value, enabledLocales: await getEnabledLocalesPg(db).catch(() => []) });
  res.cookies.set(LOCALE_COOKIE, parsed.value.locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", secure: process.env["NODE_ENV"] === "production" });
  return res;
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
