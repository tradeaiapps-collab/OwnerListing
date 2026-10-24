import { NextResponse } from "next/server";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investStaffGate, ok } from "../../../../../src/server/investment-route";

/** Signed contracts waiting for staff. File metadata only (no storage key); the file itself comes from the file route. */
export async function GET(req: Request) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const items = await deps.repo.listContracts("submitted");
  return ok({ items: items.map(c => ({ interest: c.interest, projectTitle: c.projectTitle, ...(c.file ? { file: { id: c.file.id, sizeBytes: c.file.sizeBytes, sha256: c.file.sha256, uploadedAt: c.file.uploadedAt } } : {}) })) });
}
