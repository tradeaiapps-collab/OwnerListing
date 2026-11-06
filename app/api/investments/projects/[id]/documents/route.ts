import { NextResponse } from "next/server";
import { listProjectDocuments, precheckProjectDoc, PROJECT_DOC_MAX_BYTES, uploadProjectDocument } from "../../../../../../src/domain/project-documents";
import { PHOTO_UPLOAD_RATE, UPLOAD_QUOTA_WINDOW_MS, withinByteQuota, withinLimit } from "../../../../../../src/domain/rate-limit";
import { getDb, getUploadPorts } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { createPgProjectDocStore } from "../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../src/server/api/with-api";

const MAX_REQUEST_BYTES = PROJECT_DOC_MAX_BYTES + 64 * 1024;

/** The project's documents this caller may see (metadata only): the owner sees all, an investor sees "investors" documents. Else 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await listProjectDocuments(deps, createPgProjectDocStore(getDb()), actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

/**
 * Owner adds one document (multipart: file, kind, visibility, title, optional supersedesId). Type from the bytes, filename
 * discarded, malware scanned; 503 while storage or the scanner is not configured. Shares the upload rate and daily byte quota.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps, { json: false });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const store = createPgProjectDocStore(getDb()), ports = getUploadPorts();
  const early = await precheckProjectDoc(deps, ports, actor, id);
  if (early) return invFailure(early);
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return NextResponse.json({ error: "The file is missing." }, { status: 411 });
  if (length > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Each document must be 50 MB or smaller." }, { status: 413 });
  try {
    if (!withinLimit(await deps.countHit(`project-doc-upload:${actor.userId}`, PHOTO_UPLOAD_RATE.windowMs), PHOTO_UPLOAD_RATE.perUser)) {
      return NextResponse.json({ error: "Too many uploads. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    }
    const since = new Date(Date.parse(deps.now()) - UPLOAD_QUOTA_WINDOW_MS).toISOString();
    if (!withinByteQuota(await store.bytesUploadedSince(actor.userId, since), length)) {
      return NextResponse.json({ error: "Daily upload limit reached. Try again tomorrow." }, { status: 429, headers: { "Retry-After": "3600" } });
    }
  } catch {
    return NextResponse.json({ error: "Uploads are unavailable right now. Try again later." }, { status: 503 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file"), kind = form.get("kind"), visibility = form.get("visibility"), title = form.get("title"), supersedes = form.get("supersedesId");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
  if (typeof kind !== "string" || typeof visibility !== "string" || typeof title !== "string") return NextResponse.json({ error: "A title, kind and visibility are required." }, { status: 400 });
  if (supersedes !== null && (typeof supersedes !== "string" || !UUID.test(supersedes))) return NextResponse.json({ error: "Invalid earlier version." }, { status: 400 });
  const r = await uploadProjectDocument(deps, store, ports, actor, id, {
    kind, visibility, title, declaredMime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), ...(supersedes ? { supersedesId: supersedes } : {})
  });
  return r.ok ? ok({ id: r.value.id }, 201) : invFailure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
