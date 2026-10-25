import { NextResponse } from "next/server";
import { listPhotos, precheckPhotoUpload, uploadPhoto } from "../../../../../src/domain/photo-service";
import { PHOTO_LIMITS } from "../../../../../src/domain/listing-photos";
import { hashToken } from "../../../../../src/domain/offer-intake";
import { PHOTO_UPLOAD_RATE, UPLOAD_QUOTA_WINDOW_MS, windowStart, withinByteQuota, withinLimit } from "../../../../../src/domain/rate-limit";
import { getActor, getDb, getDeps, getPhotoPorts } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { staffPhotoAccess, UUID } from "../../../../../src/server/photo-route";
import { createPgPhotoStore } from "../../../../../src/server/photos-db";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";

type Ctx = { params: Promise<{ id: string }> };

/** The gallery the caller may see: visible photos of a published listing, or a draft's photos for its owner, photographer/agent or staff. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const r = await listPhotos(getDeps(), createPgPhotoStore(getDb()), await getActor(req), id, await staffPhotoAccess(req));
  if (!r.ok) return failure(r);
  return NextResponse.json(r.value, { headers: { "cache-control": "private, no-store" } });
}

/** One image plus form overhead. */
const MAX_REQUEST_BYTES = PHOTO_LIMITS.maxBytes + 64 * 1024;

/**
 * Adds one photo or floor plan (multipart: file, kind, optional replacesId). Owner or approved photographer/agent, current terms.
 * The type comes from the bytes (JPEG, PNG, WebP), metadata (EXIF/GPS/XMP) is stripped before storing, the filename is
 * discarded and the file is malware scanned. Refused (503) while storage or the scanner is not configured. No delete here.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const deps = getDeps(), store = createPgPhotoStore(getDb()), ports = await getPhotoPorts();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  // Cheap checks first, so a wrong-role or unconfigured request never makes the server buffer the body.
  const early = await precheckPhotoUpload(deps, store, ports, actor, id);
  if (early) return failure(early);
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return NextResponse.json({ error: "The photo is missing." }, { status: 411 });
  if (length > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Each photo must be 10 MB or smaller." }, { status: 413 });
  // Per-user rate and the shared daily byte quota, before the body is read. A store error refuses the upload.
  const now = deps.now();
  try {
    const hits = await countHitPg(getDb(), await hashToken(`photo-upload:${actor.userId}`), windowStart(now, PHOTO_UPLOAD_RATE.windowMs));
    if (!withinLimit(hits, PHOTO_UPLOAD_RATE.perUser)) {
      return NextResponse.json({ error: "Too many uploads. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    }
    const since = new Date(Date.parse(now) - UPLOAD_QUOTA_WINDOW_MS).toISOString();
    if (!withinByteQuota(await store.bytesUploadedSince(actor.userId, since), length)) {
      return NextResponse.json({ error: "Daily upload limit reached. Try again tomorrow." }, { status: 429, headers: { "Retry-After": "3600" } });
    }
  } catch {
    return NextResponse.json({ error: "Uploads are unavailable right now. Try again later." }, { status: 503 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file"), kind = form.get("kind") ?? "photo", replaces = form.get("replacesId");
  if (!(file instanceof File) || typeof kind !== "string") return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > PHOTO_LIMITS.maxBytes) return NextResponse.json({ error: "Each photo must be 10 MB or smaller." }, { status: 413 });
  if (replaces !== null && (typeof replaces !== "string" || !UUID.test(replaces))) return NextResponse.json({ error: "Invalid photo to replace." }, { status: 400 });
  const r = await uploadPhoto(deps, store, ports, actor, id, {
    kind, declaredMime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), ...(replaces ? { replacesId: replaces } : {})
  });
  return r.ok ? NextResponse.json({ id: r.value.id }, { status: 201 }) : failure(r);
}
