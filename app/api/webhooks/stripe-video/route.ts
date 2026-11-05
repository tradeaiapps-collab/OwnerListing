import { NextResponse } from "next/server";
import { getVideoRepo, handleVideoStripeWebhook, kickQueue, videoIds } from "../../../../src/server/listing-video-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Stripe webhook for tour video payments (its own endpoint and signing secret, STRIPE_VIDEO_WEBHOOK_SECRET). Not cookie-authenticated, so no
 * csrfGuard: the Stripe-Signature HMAC is the authentication. Everything is rejected while the secret is unset.
 */
async function handlePost(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 256 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handleVideoStripeWebhook(getVideoRepo(), await req.text(), req.headers.get("stripe-signature"), process.env["STRIPE_VIDEO_WEBHOOK_SECRET"], videoIds);
  if (reply.status === 200) await kickQueue();
  return NextResponse.json(reply.body, { status: reply.status });
}
export const POST = withApi(handlePost);
