import { NextResponse } from "next/server";
import { getInvestmentDeps } from "../../../../../../../src/server/investments-db";
import { investStaffGate, notFound, UUID, type Ctx } from "../../../../../../../src/server/investment-route";
import { staffAudit } from "../../../../../../../src/server/staff-route";

/** Staff download of the latest signed copy. Generic filename, PDF only, audited. Parties never download each other's copies here. */
export async function GET(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const f = await deps.repo.latestContractFile(id);
  if (!f || !deps.files.storage.configured) return notFound();
  const bytes = await deps.files.storage.get(f.storageKey).catch(() => null);
  if (!bytes) return notFound();
  await staffAudit(staff, "investment_interest", id, "investment.contract_downloaded", { fileId: f.id });
  return new NextResponse(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="signed-contract-${f.id}.pdf"`, "x-content-type-options": "nosniff", "cache-control": "no-store" }
  });
}
