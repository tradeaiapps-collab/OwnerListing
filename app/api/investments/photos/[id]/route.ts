import { readProjectPhoto } from "../../../../../src/domain/project-photos";
import { getActor, getDb, getUploadPorts } from "../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { invFailure, notFound, UUID, type Ctx } from "../../../../../src/server/investment-route";
import { photoResponse, sizeParam } from "../../../../../src/server/project-photo-route";
import { createPgProjectPhotoStore } from "../../../../../src/server/project-photos-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** One project photo (?size=thumb|medium). The owner, or an investor who may see the project. Denials are 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  if (!(await deps.moduleState()).live) return notFound();
  const { id } = await params;
  const size = sizeParam(req);
  if (!UUID.test(id) || !size) return notFound();
  const actor = await getActor(req);
  if (!actor) return notFound();
  const r = await readProjectPhoto(deps, createPgProjectPhotoStore(getDb()), getUploadPorts().storage, actor, id, size);
  return r.ok ? photoResponse(r.value.bytes, r.value.contentType) : invFailure(r);
}

export const GET = withApi(handleGet);
