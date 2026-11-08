import { NextResponse } from "next/server";
import { readProjectDocument } from "../../../../../../src/domain/project-documents";
import { getDb, getUploadPorts } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { documentResponse } from "../../../../../../src/server/project-photo-route";
import { createPgProjectDocStore } from "../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../src/server/api/with-api";

/** One project document for reviewing staff (team and investor documents). Each staff view is written to the audit log. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await readProjectDocument(deps, createPgProjectDocStore(getDb()), getUploadPorts().storage, null, id, { staffId: staff.id });
  return r.ok ? documentResponse(r.value.bytes, r.value.contentType, r.value.title) : invFailure(r);
}

export const GET = withApi(handleGet);
