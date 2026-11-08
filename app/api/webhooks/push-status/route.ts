import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { createPgEventStore } from "../../../../src/server/providers/store-db";
import { handleProviderWebhook } from "../../../../src/server/providers/webhook";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Push delivery-status webhook (FCM/APNs relay). Not cookie-authenticated, so no csrfGuard: the signed timestamp + HMAC
 * (secret PUSH_STATUS_WEBHOOK_SECRET, 32+ characters) is the authentication. Everything is rejected while the secret is unset.
 * Verified events are stored raw in provider_events; applying them to push_delivery rows comes with the FCM/APNs PRs.
 * The provider is chosen by ?provider=fcm|apns (anything else is refused).
 */
async function handlePost(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider");
  if (provider !== "fcm" && provider !== "apns") return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  if (Number(req.headers.get("content-length") ?? 0) > 256 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handleProviderWebhook({
    provider, secret: process.env["PUSH_STATUS_WEBHOOK_SECRET"], rawBody: await req.text(), headers: req.headers,
    store: createPgEventStore(getDb()), nowSeconds: Math.floor(Date.now() / 1000)
  });
  return NextResponse.json(reply.body, { status: reply.status });
}

export const POST = withApi(handlePost);
