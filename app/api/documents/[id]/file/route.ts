import { NextResponse } from "next/server";
import { readDocumentFile } from "../../../../../src/domain/document-service";
import { getActor, getDb, getDeps, getUploadPorts } from "../../../../../src/server/context";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downloads a file. A session is optional only because public files of published listings are public;
 * everything else needs the right role (see readDocumentFile). Always sent as an attachment with the stored,
 * sniffed content type and nosniff, so an uploaded file can never run as a page in our origin.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "File not found." });
  const r = await readDocumentFile(getDeps(), createPgDocumentStore(getDb()), getUploadPorts().storage, await getActor(req), id);
  if (!r.ok) return r.code === "unavailable" ? NextResponse.json({ error: r.message }, { status: 503 }) : failure(r);
  return new NextResponse(r.value.bytes as BodyInit, {
    headers: {
      "content-type": r.value.contentType,
      "content-length": String(r.value.bytes.length),
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store"
    }
  });
}
