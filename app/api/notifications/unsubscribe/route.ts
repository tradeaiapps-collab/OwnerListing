import { NextResponse } from "next/server";
import { CATEGORY_INFO } from "../../../../src/domain/notifications";
import { getDb } from "../../../../src/server/context";
import { disableDigestPg, readDigestUnsubscribeToken } from "../../../../src/server/notification-digest";
import { getPreferencesPg, readNotificationUnsubscribeToken, savePreferencesPg } from "../../../../src/server/notifications-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * One-click email unsubscribe for a category (marketing) or the daily digest. The signed token is the only credential, so CSRF does not apply.
 * GET shows a confirm button (a mail scanner opening the link changes nothing); POST switches email off for that category
 * (also the target of List-Unsubscribe-Post) and logs it as consent withdrawn.
 */
const page = (body: string, status = 200) =>
  new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const tokenOf = (req: Request) => new URL(req.url).searchParams.get("t");
const invalid = () => page("<h1>This link is not valid</h1><p>Open Notification settings in your account to change your emails.</p>", 400);

async function handleGet(req: Request) {
  const t = tokenOf(req);
  if (readDigestUnsubscribeToken(t, process.env["ALERT_UNSUBSCRIBE_KEY"]))
    return page(`<h1>Stop the daily digest?</h1><form method="post" action="?t=${encodeURIComponent(t ?? "")}"><button type="submit">Stop the digest</button></form>`);
  if (!readNotificationUnsubscribeToken(t, process.env["ALERT_UNSUBSCRIBE_KEY"])) return invalid();
  return page(`<h1>Stop these emails?</h1><form method="post" action="?t=${encodeURIComponent(t ?? "")}"><button type="submit">Unsubscribe</button></form>`);
}

async function handlePost(req: Request) {
  const digestWho = readDigestUnsubscribeToken(tokenOf(req), process.env["ALERT_UNSUBSCRIBE_KEY"]);
  if (digestWho) {
    await disableDigestPg(getDb(), digestWho.userId);
    return page("<h1>The daily digest is off</h1><p>You will not get it again. You can turn it back on in Notification settings.</p>");
  }
  const who = readNotificationUnsubscribeToken(tokenOf(req), process.env["ALERT_UNSUBSCRIBE_KEY"]);
  if (!who) return invalid();
  const info = CATEGORY_INFO[who.category];
  if (info.locked.includes("email")) return invalid();
  const current = (await getPreferencesPg(getDb(), who.userId))[who.category];
  await savePreferencesPg(getDb(), who.userId, { [who.category]: { ...current, email: false } }, "unsubscribe_link");
  return page("<h1>You are unsubscribed</h1><p>You will not get these emails again. You can turn them back on in your account.</p>");
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
