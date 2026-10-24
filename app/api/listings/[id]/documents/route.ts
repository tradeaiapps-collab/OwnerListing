import { NextResponse } from "next/server";
import { listDocuments } from "../../../../../src/domain/document-service";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lists a listing's documents the caller may see (metadata only). Signed-out visitors see public files of published listings. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const r = await listDocuments(getDeps(), createPgDocumentStore(getDb()), getActor(req), id);
  return r.ok ? NextResponse.json({ documents: r.value }) : failure(r);
}
