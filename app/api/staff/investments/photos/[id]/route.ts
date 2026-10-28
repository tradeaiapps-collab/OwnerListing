import { NextResponse } from "next/server";
import { readProjectPhoto } from "../../../../../../src/domain/project-photos";
import { getDb, getUploadPorts } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { createPgProjectPhotoStore } from "../../../../../../src/server/project-photos-db";
import { photoResponse, sizeParam } from "../../../../../../src/server/project-photo-route";

/** One project photo for reviewing staff (hidden ones too). Each staff view is written to the audit log. */
export async function GET(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  const size = sizeParam(req);
  if (!UUID.test(id) || !size) return notFound();
  const r = await readProjectPhoto(deps, createPgProjectPhotoStore(getDb()), getUploadPorts().storage, null, id, size, { staffId: staff.id });
  return r.ok ? photoResponse(r.value.bytes, r.value.contentType) : invFailure(r);
}
