import { NextResponse } from "next/server";
import { startBuyerPurchase, videoPricing } from "../../../../src/domain/listing-video";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getCheckout, getVideoProvider, getVideoRepo, kickQueue, videoIds } from "../../../../src/server/listing-video-db";
import { withApi } from "../../../../src/server/api/with-api";

const origin = (req: Request) => (/^https?:\/\/[^/\s]+$/.test(process.env["APP_URL"] ?? "") ? process.env["APP_URL"]! : new URL(req.url).origin);

/** Model 2: a signed-in visitor pays once for a tour video. Body: { listingId }. Answers { checkoutUrl } to send the browser to Stripe, or { alreadyPaid } if they paid before. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { listingId?: unknown } | null;
  const base = origin(req);
  const r = await startBuyerPurchase(
    getVideoRepo(), getCheckout(), getVideoProvider(), actor, body?.listingId, videoPricing(process.env),
    { success: id => `${base}/listings/${id}?video=paid`, cancel: id => `${base}/listings/${id}?video=cancelled` }, videoIds
  );
  if (!r.ok) return failure(r);
  if ("alreadyPaid" in r.value) await kickQueue();
  return NextResponse.json(r.value);
}
export const POST = withApi(handlePost);
