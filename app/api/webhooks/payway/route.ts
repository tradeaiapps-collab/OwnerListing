import { NextResponse } from "next/server";
import { getBilling } from "../../../../src/server/context";
import { SIGNATURE_HEADER, handlePaymentWebhook } from "../../../../src/server/payment-webhook";

/**
 * Payment provider webhook. Not cookie-authenticated, so no csrfGuard: the HMAC signature (secret from PAYWAY_WEBHOOK_SECRET)
 * is the authentication. Everything is rejected while the secret is unset.
 */
export async function POST(req: Request) {
  const secret = process.env["PAYWAY_WEBHOOK_SECRET"];
  const reply = await handlePaymentWebhook(getBilling(), await req.text(), req.headers.get(SIGNATURE_HEADER), secret);
  return NextResponse.json(reply.body, { status: reply.status });
}
