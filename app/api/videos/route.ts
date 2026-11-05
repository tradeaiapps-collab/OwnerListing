import { NextResponse } from "next/server";
import { agentVideos, videoForListing, videoPricing } from "../../../src/domain/listing-video";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { getVideoRepo, videoIds } from "../../../src/server/listing-video-db";
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
    return r.ok ? NextResponse.json({ ...r.value, priceCents: r.value.canBuy ? videoPricing(process.env).buyerPriceCents : null }) : failure(r);
  }
  if (!actor) return unauthenticated();
  const r = await agentVideos(repo, actor, videoPricing(process.env), videoIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
export const GET = withApi(handleGet);
