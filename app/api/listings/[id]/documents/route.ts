import { NextResponse } from "next/server";
import { listDocuments, uploadAccess } from "../../../../../src/domain/document-service";
import { precheckUpload, uploadDocument } from "../../../../../src/domain/document-upload";
import { DOCUMENT_KINDS, type DocumentKind, type Visibility } from "../../../../../src/domain/documents";
import { getActor, getDb, getDeps, getUploadPorts } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lists a listing's documents the caller may see (metadata only), and which kinds the caller may add.
 * Signed-out visitors see public files of published listings.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const store = createPgDocumentStore(getDb()), actor = await getActor(req);
  const r = await listDocuments(getDeps(), store, actor, id);
  return r.ok ? NextResponse.json({ documents: r.value, canUpload: await uploadAccess(getDeps(), store, actor, id) }) : failure(r);
}

/** This route buffers the file in memory, so it takes up to 100 MB. Larger videos need a streaming upload (not built). */
const MAX_REQUEST_BYTES = 100_000_000;

/**
 * Adds a file (multipart: file, kind, visibility, optional supersedesId). Needs a session and the owner or an approved contractor role.
 * The filename and declared type are never trusted: the type is checked from the file's bytes, the name is discarded,
 * and only a random storage key and the SHA-256 are kept. Refused while storage or the malware scanner is not configured.
 * There is no delete here: replacing a file creates a new version and keeps the old one.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const store = createPgDocumentStore(getDb()), ports = getUploadPorts();
  // Cheap checks first, so a wrong-role or unconfigured request never makes the server buffer the body.
  const early = await precheckUpload(getDeps(), store, ports, actor, id);
  if (early && !early.ok) return early.code === "unavailable" ? NextResponse.json({ error: early.message }, { status: 503 }) : failure(early);
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "File is missing or too large for this upload." }, { status: 413 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file"), kind = form.get("kind"), visibility = form.get("visibility"), supersedes = form.get("supersedesId");
  if (!(file instanceof File) || typeof kind !== "string" || !(DOCUMENT_KINDS as readonly string[]).includes(kind) || typeof visibility !== "string") {
    return NextResponse.json({ error: "A file, kind and visibility are required." }, { status: 400 });
  }
  if (supersedes !== null && (typeof supersedes !== "string" || !UUID.test(supersedes))) {
    return NextResponse.json({ error: "Invalid earlier version." }, { status: 400 });
  }
  const r = await uploadDocument(getDeps(), store, ports, actor, id, {
    kind: kind as DocumentKind, visibility: visibility as Visibility, declaredMime: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()), ...(supersedes ? { supersedesId: supersedes } : {})
  });
  if (r.ok) return NextResponse.json({ id: r.value.id }, { status: 201 });
  return r.code === "unavailable" ? NextResponse.json({ error: r.message }, { status: 503 }) : failure(r);
}
