import { NextResponse } from "next/server";
import { readPhoto } from "../../../../src/domain/photo-service";
import type { PhotoSize } from "../../../../src/domain/listing-photos";
import { getActor, getDb, getDeps, getUploadPorts } from "../../../../src/server/context";
import { failure } from "../../../../src/server/http";
import { imageHeaders, staffPhotoAccess, UUID } from "../../../../src/server/photo-route";
import { createPgPhotoStore } from "../../../../src/server/photos-db";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const SIZES: readonly PhotoSize[] = ["thumb", "medium", "full"];

/**
 * One listing photo (?size=thumb|medium, default full). Public only for a showing photo of a published listing; drafts and
 * hidden photos only for the owner, the listing's photographer/agent or staff (see readPhoto). Denials are 404.
 * The Content-Type is the stored, sniffed image type; nosniff and a sandbox CSP stop it ever running as a page.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const size = new URL(req.url).searchParams.get("size") ?? "full";
  if (!UUID.test(id) || !(SIZES as readonly string[]).includes(size)) return failure({ ok: false, code: "not_found", message: "Photo not found." });
  const actor = await getActor(req);
  const r = await readPhoto(getDeps(), createPgPhotoStore(getDb()), getUploadPorts().storage, actor, id, size as PhotoSize, await staffPhotoAccess(req));
  if (!r.ok) return failure(r);
  return new NextResponse(r.value.bytes as BodyInit, { headers: imageHeaders(r.value.contentType, r.value.bytes.length, r.value.isPublic) });
}

export const GET = withApi(handleGet);
