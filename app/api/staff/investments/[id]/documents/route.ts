import { NextResponse } from "next/server";
import { listProjectDocuments } from "../../../../../../src/domain/project-documents";
import { getDb } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { createPgProjectDocStore } from "../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Reviewing staff see the team and investor documents (not private ones). Read only. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await listProjectDocuments(deps, createPgProjectDocStore(getDb()), null, id, { staffId: staff.id });
  return r.ok ? ok(r.value) : invFailure(r);
}

export const GET = withApi(handleGet);
