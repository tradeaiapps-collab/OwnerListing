import { NextResponse } from "next/server";
import { documentPageInfo } from "../../../../../../src/domain/project-document-masking";
import { getActor, getDb, getMaskPorts } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { createPgProjectDocStore } from "../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Page count of a document for the in-site viewer. Investors only while the address masking is confirmed; denials are 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  if (!(await deps.moduleState()).live) return notFound();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const actor = await getActor(req);
  if (!actor) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const r = await documentPageInfo(deps, createPgProjectDocStore(getDb()), getMaskPorts(), actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

export const GET = withApi(handleGet);
