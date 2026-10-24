import { NextResponse } from "next/server";
import { listDocuments } from "../../../../../src/domain/document-service";
import { uploadDocument } from "../../../../../src/domain/document-upload";
import type { DocumentKind, Visibility } from "../../../../../src/domain/documents";
import { getActor, getDb, getDeps, getUploadPorts } from "../../../../../src/server/context";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lists a listing's documents the caller may see (metadata only). Signed-out visitors see public files of published listings. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const r = await listDocuments(getDeps(), createPgDocumentStore(getDb()), getActor(req), id);
  return r.ok ? NextResponse.json({ documents: r.value }) : failure(r);
}

/** This route buffers the file in memory, so it takes up to 100 MB. Larger videos need a streaming upload (not built). */
const MAX_REQUEST_BYTES = 100_000_000;
const KINDS = ["photo", "photo_360", "video", "video_360", "floorplan", "title_search", "building_inspection", "pest_report", "contract", "other"];

/**
 * Adds a file (multipart: file, kind, visibility, optional supersedesId). Needs a session and the owner or an approved contractor role.
 * The filename and declared type are never trusted: the type is checked from the file's bytes, the name is discarded,
 * and only a random storage key and the SHA-256 are kept. Refused while storage or the malware scanner is not configured.
 * There is no delete here: replacing a file creates a new version and keeps the old one.
 */
export async function POST(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "File is missing or too large for this upload." }, { status: 413 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file"), kind = form.get("kind"), visibility = form.get("visibility"), supersedes = form.get("supersedesId");
  if (!(file instanceof File) || typeof kind !== "string" || !KINDS.includes(kind) || typeof visibility !== "string") {
    return NextResponse.json({ error: "A file, kind and visibility are required." }, { status: 400 });
  }
  if (supersedes !== null && (typeof supersedes !== "string" || !UUID.test(supersedes))) {
    return NextResponse.json({ error: "Invalid earlier version." }, { status: 400 });
  }
  const r = await uploadDocument(getDeps(), createPgDocumentStore(getDb()), getUploadPorts(), actor, id, {
    kind: kind as DocumentKind, visibility: visibility as Visibility, declaredMime: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()), ...(supersedes ? { supersedesId: supersedes } : {})
  });
  if (r.ok) return NextResponse.json({ id: r.value.id }, { status: 201 });
  return r.code === "unavailable" ? NextResponse.json({ error: r.message }, { status: 503 }) : failure(r);
}
