import { readProjectDocument } from "../../../../../src/domain/project-documents";
import { getActor, getDb, getUploadPorts } from "../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { invFailure, notFound, UUID, type Ctx } from "../../../../../src/server/investment-route";
import { documentResponse } from "../../../../../src/server/project-photo-route";
import { createPgProjectDocStore } from "../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** One project document as a download. The owner, or an investor who may see the project and the document. Denials are 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  if (!(await deps.moduleState()).live) return notFound();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const actor = await getActor(req);
  if (!actor) return notFound();
  const r = await readProjectDocument(deps, createPgProjectDocStore(getDb()), getUploadPorts().storage, actor, id);
  return r.ok ? documentResponse(r.value.bytes, r.value.contentType, r.value.title) : invFailure(r);
}

export const GET = withApi(handleGet);
