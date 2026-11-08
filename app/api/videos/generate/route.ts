import { NextResponse } from "next/server";
import { requestTeamVideo, videoPricing } from "../../../../src/domain/listing-video";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getVideoProvider, getVideoRepo, kickQueue, videoIds } from "../../../../src/server/listing-video-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Model 1: an appointed agent in a team asks for a video of a listing. Body: { listingId }. The team budget is charged first; the job runs in the background. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { listingId?: unknown } | null;
  const r = await requestTeamVideo(getVideoRepo(), actor, body?.listingId, videoPricing(process.env), getVideoProvider(), videoIds);
  if (!r.ok) return failure(r);
  await kickQueue();
  return NextResponse.json({ video: { id: r.value.id, status: r.value.status } }, { status: 202 });
}
export const POST = withApi(handlePost);
