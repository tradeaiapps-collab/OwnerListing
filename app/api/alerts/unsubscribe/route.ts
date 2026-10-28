import { NextResponse } from "next/server";
import { readUnsubscribeToken } from "../../../../src/server/alert-unsubscribe";
import { unsubscribeAlertPg } from "../../../../src/server/alert-outbox-db";
import { getDb } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * One-click unsubscribe from an alert message. The signed token in the link is the only credential (no cookie), so CSRF does not apply.
 * GET shows a confirm button, so a mail scanner that opens the link changes nothing; POST does the unsubscribe
 * (also the target of the List-Unsubscribe-Post header). A bad or unsigned token gets the same 400 every time.
 */
const page = (body: string, status = 200) =>
  new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alert emails and texts</title></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const tokenOf = (req: Request) => new URL(req.url).searchParams.get("t");
const invalid = () => page("<h1>This link is not valid</h1><p>Open Saved searches in your account to change your alerts.</p>", 400);

async function handleGet(req: Request) {
  const t = tokenOf(req);
  if (!readUnsubscribeToken(t, process.env["ALERT_UNSUBSCRIBE_KEY"])) return invalid();
  return page(`<h1>Stop these alerts?</h1><form method="post" action="?t=${encodeURIComponent(t ?? "")}"><button type="submit">Unsubscribe</button></form>`);
}

async function handlePost(req: Request) {
  const who = readUnsubscribeToken(tokenOf(req), process.env["ALERT_UNSUBSCRIBE_KEY"]);
  if (!who) return invalid();
  await unsubscribeAlertPg(getDb(), who.buyerUserId, who.channel, new Date().toISOString());
  return page("<h1>You are unsubscribed</h1><p>You will not get these alerts again. You can turn them back on in your account.</p>");
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
