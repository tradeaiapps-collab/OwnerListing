import { NextResponse } from "next/server";
import { agentVideos, videoForListing, videoPricing } from "../../../src/domain/listing-video";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { getCheckout, getVideoProvider, getVideoRepo, videoIds } from "../../../src/server/listing-video-db";
import { withApi } from "../../../src/server/api/with-api";

/**
 * GET /api/videos?listingId=...  what a listing page shows: the published video, or the viewer's own paid one, and whether they can buy one.
 * GET /api/videos                an agent's appointed listings with video status, the team budget and Elena's suggestion.
 */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  const listingId = new URL(req.url).searchParams.get("listingId");
  const repo = getVideoRepo();
  if (listingId) {
    const r = await videoForListing(repo, actor, listingId);
    if (!r.ok) return failure(r);
    // Only offer the purchase when it can actually go through (Hedra key set and payments on); otherwise the page shows nothing.
    const canBuy = r.value.canBuy && getVideoProvider().configured && getCheckout().enabled;
    return NextResponse.json({ ...r.value, canBuy, priceCents: canBuy ? videoPricing(process.env).buyerPriceCents : null });
  }
  if (!actor) return unauthenticated();
  const r = await agentVideos(repo, actor, videoPricing(process.env), videoIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
export const GET = withApi(handleGet);
