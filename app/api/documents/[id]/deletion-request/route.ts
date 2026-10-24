import { NextResponse } from "next/server";
import { requestDocumentDeletion } from "../../../../../src/domain/document-service";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Records a deletion request and its outcome. It never deletes a file: published files can only be replaced. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Document not found." });
  const r = await requestDocumentDeletion(getDeps(), createPgDocumentStore(getDb()), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
