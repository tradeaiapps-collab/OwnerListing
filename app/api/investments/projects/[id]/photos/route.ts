import { NextResponse } from "next/server";
import { PHOTO_LIMITS } from "../../../../../../src/domain/listing-photos";
import { listProjectPhotos, precheckProjectPhoto, updateProjectLayout, uploadProjectPhoto } from "../../../../../../src/domain/project-photos";
import { PHOTO_LAYOUT_RATE, PHOTO_UPLOAD_RATE, UPLOAD_QUOTA_WINDOW_MS, withinByteQuota, withinLimit } from "../../../../../../src/domain/rate-limit";
import { getDb, getPhotoPorts } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { createPgPhotoStore } from "../../../../../../src/server/photos-db";
import { createPgProjectPhotoStore } from "../../../../../../src/server/project-photos-db";

const MAX_REQUEST_BYTES = PHOTO_LIMITS.maxBytes + 64 * 1024;

/** The project's gallery: the owner (hidden photos too) or an investor who may see the project (showing photos). Else 404. */
export async function GET(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await listProjectPhotos(deps, createPgProjectPhotoStore(getDb()), actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

/**
 * Owner adds one photo (multipart: file, optional replacesId). Type from the bytes, metadata stripped, filename discarded,
 * malware scanned; 503 while storage or the scanner is not configured. Shares the listing photo rate and daily byte quota.
 */
export async function POST(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps, { json: false });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const store = createPgProjectPhotoStore(getDb()), ports = await getPhotoPorts();
  const early = await precheckProjectPhoto(deps, ports, actor, id);
  if (early) return invFailure(early);
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return NextResponse.json({ error: "The photo is missing." }, { status: 411 });
  if (length > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Each photo must be 10 MB or smaller." }, { status: 413 });
  try {
    if (!withinLimit(await deps.countHit(`photo-upload:${actor.userId}`, PHOTO_UPLOAD_RATE.windowMs), PHOTO_UPLOAD_RATE.perUser)) {
      return NextResponse.json({ error: "Too many uploads. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    }
    const since = new Date(Date.parse(deps.now()) - UPLOAD_QUOTA_WINDOW_MS).toISOString();
    const [projectBytes, listingBytes] = await Promise.all([store.bytesUploadedSince(actor.userId, since), createPgPhotoStore(getDb()).bytesUploadedSince(actor.userId, since)]);
    const used = projectBytes === undefined || listingBytes === undefined ? undefined : projectBytes + listingBytes;
    if (!withinByteQuota(used, length)) {
      return NextResponse.json({ error: "Daily upload limit reached. Try again tomorrow." }, { status: 429, headers: { "Retry-After": "3600" } });
    }
  } catch {
    return NextResponse.json({ error: "Uploads are unavailable right now. Try again later." }, { status: 503 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file"), replaces = form.get("replacesId");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > PHOTO_LIMITS.maxBytes) return NextResponse.json({ error: "Each photo must be 10 MB or smaller." }, { status: 413 });
  if (replaces !== null && (typeof replaces !== "string" || !UUID.test(replaces))) return NextResponse.json({ error: "Invalid photo to replace." }, { status: 400 });
  const r = await uploadProjectPhoto(deps, store, ports, actor, id, {
    declaredMime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), ...(replaces ? { replacesId: replaces } : {})
  });
  return r.ok ? ok({ id: r.value.id }, 201) : invFailure(r);
}

/** Owner saves the whole order, captions, descriptions and hidden flags: { version, entries }. */
export async function PUT(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  try {
    if (!withinLimit(await deps.countHit(`photo-layout:${actor.userId}`, PHOTO_LAYOUT_RATE.windowMs), PHOTO_LAYOUT_RATE.perUser)) {
      return NextResponse.json({ error: "Too many changes. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    }
  } catch {
    return NextResponse.json({ error: "The gallery could not be saved right now." }, { status: 503 });
  }
  const r = await updateProjectLayout(deps, createPgProjectPhotoStore(getDb()), actor, id, await req.json().catch(() => null));
  return r.ok ? ok(r.value) : invFailure(r);
}
