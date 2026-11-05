import { NextResponse } from "next/server";
import { archiveVideo, getVideo } from "../../../../src/domain/listing-video";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getVideoRepo, videoIds } from "../../../../src/server/listing-video-db";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Status of one video (and its playback url once it is ready and the viewer may watch). */
async function handleGet(req: Request, { params }: Ctx) {
  const r = await getVideo(getVideoRepo(), await getActor(req), (await params).id);
  return r.ok ? NextResponse.json({ video: r.value }) : failure(r);
}
export const GET = withApi(handleGet);

/** Delete (or replace, by deleting and generating again). The video leaves the listing; the stored file is kept. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await archiveVideo(getVideoRepo(), actor, (await params).id, videoIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
export const DELETE = withApi(handleDelete);
