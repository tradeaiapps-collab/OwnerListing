import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { createPgEventStore } from "../../../../src/server/providers/store-db";
import { handleProviderWebhook } from "../../../../src/server/providers/webhook";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * MLS data-update webhook. Not cookie-authenticated, so no csrfGuard: the signed timestamp + HMAC (secret MLS_WEBHOOK_SECRET,
 * 32+ characters) is the authentication. Everything is rejected while the secret is unset. Verified events are stored raw in
 * provider_events; syncing the listed property data comes with the MLS PR.
 */
async function handlePost(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 256 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handleProviderWebhook({
    provider: "mls", secret: process.env["MLS_WEBHOOK_SECRET"], rawBody: await req.text(), headers: req.headers,
    store: createPgEventStore(getDb()), nowSeconds: Math.floor(Date.now() / 1000)
  });
  return NextResponse.json(reply.body, { status: reply.status });
}

export const POST = withApi(handlePost);
