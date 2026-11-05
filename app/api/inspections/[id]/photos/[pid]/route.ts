import { NextResponse } from "next/server";
import { readInspectionPhoto } from "../../../../../../src/domain/inspection-photo";
import { getActor, getDb, getUploadPorts } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { createPgInspectionPhotoStore, getInspectionRepo } from "../../../../../../src/server/inspection-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; pid: string }> };

/** One photo, for people who can see the report. Never public and never cached by shared caches. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, pid } = await params;
  const r = await readInspectionPhoto(getInspectionRepo(), createPgInspectionPhotoStore(getDb()), getUploadPorts().storage, actor, id, pid);
  if (!r.ok) return failure(r);
  return new NextResponse(Buffer.from(r.value.bytes), {
    headers: { "content-type": r.value.contentType, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-disposition": "inline" }
  });
}

export const GET = withApi(handleGet);
