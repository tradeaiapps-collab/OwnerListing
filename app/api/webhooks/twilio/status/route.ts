import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { handleSmsStatusWebhook, MAX_WEBHOOK_BYTES } from "../../../../../src/server/sms-webhook";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Twilio status webhook. Not cookie-authenticated, so no csrfGuard: the X-Twilio-Signature check is the authentication
 * (refused with 503 until APP_URL is https and a signing token exists, 403 on a bad signature).
 */
async function handlePost(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handleSmsStatusWebhook(getDb(), process.env, await req.text(), req.headers.get("x-twilio-signature"));
  return new NextResponse(reply.body, { status: reply.status, headers: { "content-type": reply.contentType, "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
