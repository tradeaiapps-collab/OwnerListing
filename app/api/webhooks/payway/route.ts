import { NextResponse } from "next/server";
import { getBilling } from "../../../../src/server/context";
import { SIGNATURE_HEADER, handlePaymentWebhook } from "../../../../src/server/payment-webhook";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Payment provider webhook. Not cookie-authenticated, so no csrfGuard: the HMAC signature (secret from PAYWAY_WEBHOOK_SECRET)
 * is the authentication. Everything is rejected while the secret is unset.
 */
async function handlePost(req: Request) {
  const secret = process.env["PAYWAY_WEBHOOK_SECRET"];
  // Refuse an oversized body before buffering it (the handler checks the real size again).
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handlePaymentWebhook(getBilling(), await req.text(), req.headers.get(SIGNATURE_HEADER), secret);
  return NextResponse.json(reply.body, { status: reply.status });
}

export const POST = withApi(handlePost);
