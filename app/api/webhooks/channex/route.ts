import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { handleChannexWebhook, MAX_WEBHOOK_BYTES, syndicationDeps } from "../../../../src/server/syndication-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Channex events (bookings for Airbnb, Booking.com and Vrbo). Verified with CHANNEX_WEBHOOK_SECRET: HMAC headers x-hmac-timestamp + x-hmac-signature-256,
 * or the custom header x-channex-webhook-secret. 404 until the secret is set.
 */
async function handlePost(req: Request) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const r = await handleChannexWebhook(getDb(), syndicationDeps(), raw, {
    timestamp: req.headers.get("x-hmac-timestamp"), signature: req.headers.get("x-hmac-signature-256"), sharedSecret: req.headers.get("x-channex-webhook-secret")
  });
  return NextResponse.json(r.body, { status: r.status });
}

export const POST = withApi(handlePost);
