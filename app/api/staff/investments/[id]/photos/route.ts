import { NextResponse } from "next/server";
import { listProjectPhotos } from "../../../../../../src/domain/project-photos";
import { getDb } from "../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";
import { createPgProjectPhotoStore } from "../../../../../../src/server/project-photos-db";

/** Reviewing staff see the whole gallery, hidden photos included (marked). Read only. */
export async function GET(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await listProjectPhotos(deps, createPgProjectPhotoStore(getDb()), null, id, { staffId: staff.id });
  return r.ok ? ok(r.value) : invFailure(r);
}
