import { NextResponse } from "next/server";
import { analyseStoredDocument, latestAnalysis } from "../../../../../src/domain/doc-analysis-service";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getActor } from "../../../../../src/server/context";
import { getAnalystDeps } from "../../../../../src/server/doc-analysis";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => failure({ ok: false, code: "not_found", message: "Document not found." });

/** Elena's latest stored reading of a document the signed-in user may view. Does not run a new one. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await latestAnalysis(getAnalystDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "private, no-store" } }) : failure(r);
}

/** Asks Elena to read the document (summary, flags, next steps). A repeat for an unchanged document returns the stored reading. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await analyseStoredDocument(getAnalystDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "private, no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
