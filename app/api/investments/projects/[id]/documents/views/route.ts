import { NextResponse } from "next/server";
import { listDocumentViews } from "../../../../../../../src/domain/project-document-views";
import { getDb } from "../../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../../src/server/investment-route";
import { createPgDocViewStore } from "../../../../../../../src/server/project-document-views-db";
import { createPgProjectDocStore } from "../../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../../src/server/api/with-api";

/** Owner only: which investors opened which documents and when. Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const db = getDb();
  const r = await listDocumentViews(deps, createPgProjectDocStore(db), createPgDocViewStore(db), actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

export const GET = withApi(handleGet);
