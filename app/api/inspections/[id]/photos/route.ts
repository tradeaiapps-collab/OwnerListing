import { NextResponse } from "next/server";
import { uploadInspectionPhoto } from "../../../../../src/domain/inspection-photo";
import { PHOTO_LIMITS } from "../../../../../src/domain/listing-photos";
import { hashToken } from "../../../../../src/domain/offer-intake";
import { PHOTO_UPLOAD_RATE, UPLOAD_QUOTA_WINDOW_MS, windowStart, withinByteQuota, withinLimit } from "../../../../../src/domain/rate-limit";
import { getActor, getDb, getUploadPorts } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { createPgInspectionPhotoStore, getInspectionRepo, inspectionIds } from "../../../../../src/server/inspection-db";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";
import { getDeps } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const MAX_REQUEST_BYTES = PHOTO_LIMITS.maxBytes + 64 * 1024;

/**
 * Adds one photo to a finding (multipart: file, optional findingId). The booked inspector only, while the inspection is accepted.
 * Type is read from the bytes, metadata (EXIF/GPS) is stripped, the filename is discarded and the file is malware scanned.
 * Refused (503) while storage or the scanner is not configured. There is no delete.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const noTerms = await requireCurrentTerms(getDeps().termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return NextResponse.json({ error: "The photo is missing." }, { status: 411 });
  if (length > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Each photo must be 10 MB or smaller." }, { status: 413 });
  const store = createPgInspectionPhotoStore(getDb());
  const now = inspectionIds.now();
  try {
    const hits = await countHitPg(getDb(), await hashToken(`inspection-photo:${actor.userId}`), windowStart(now, PHOTO_UPLOAD_RATE.windowMs));
    if (!withinLimit(hits, PHOTO_UPLOAD_RATE.perUser)) return NextResponse.json({ error: "Too many uploads. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    const since = new Date(Date.parse(now) - UPLOAD_QUOTA_WINDOW_MS).toISOString();
    const used = await store.bytesUploadedSince(actor.userId, since);
    if (used === undefined || !withinByteQuota(used, length)) return NextResponse.json({ error: "Daily upload limit reached. Try again tomorrow." }, { status: 429, headers: { "Retry-After": "3600" } });
  } catch {
    return NextResponse.json({ error: "Uploads are unavailable right now. Try again later." }, { status: 503 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file"), findingId = form.get("findingId");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > PHOTO_LIMITS.maxBytes) return NextResponse.json({ error: "Each photo must be 10 MB or smaller." }, { status: 413 });
  if (findingId !== null && typeof findingId !== "string") return NextResponse.json({ error: "Invalid finding." }, { status: 400 });
  const r = await uploadInspectionPhoto(getInspectionRepo(), store, getUploadPorts(), actor, id, {
    declaredMime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), ...(findingId ? { findingId } : {})
  }, inspectionIds);
  return r.ok ? NextResponse.json({ id: r.value.id }, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
