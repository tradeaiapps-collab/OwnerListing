import { NextResponse } from "next/server";
import { publishVideo } from "../../../../../src/domain/listing-video";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getVideoRepo, videoIds } from "../../../../../src/server/listing-video-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** After previewing a ready team video, the agent publishes it on the public listing page. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await publishVideo(getVideoRepo(), actor, (await params).id, videoIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
export const POST = withApi(handlePost);
