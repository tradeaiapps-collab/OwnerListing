import { NextResponse } from "next/server";
import { renderDocumentPage } from "../../../../../../../../src/domain/project-document-masking";
import { getDb, getMaskPorts } from "../../../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, UUID } from "../../../../../../../../src/server/investment-route";
import { pageImageResponse } from "../../../../../../../../src/server/project-photo-route";
import { createPgProjectDocStore } from "../../../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../../../src/server/api/with-api";

/** One ORIGINAL page (unmasked, watermarked) for the masking screen, or ?view=investor for the masked result. Staff only. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id, n } = await params;
  if (!UUID.test(id) || !/^\d{1,3}$/.test(n)) return notFound();
  const asInvestor = new URL(req.url).searchParams.get("view") === "investor";
  const r = await renderDocumentPage(deps, createPgProjectDocStore(getDb()), getMaskPorts(), null, id, Number(n), { staffId: staff.id }, { asInvestor });
  return r.ok ? pageImageResponse(r.value.image, r.value.contentType) : invFailure(r);
}

export const GET = withApi(handleGet);
