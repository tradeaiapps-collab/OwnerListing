import { NextResponse } from "next/server";
import { buildInspectionPdf, isUuid, offerDownload, portalAccess } from "../../../../../../../src/domain/client-portal";
import { getReport } from "../../../../../../../src/domain/inspection";
import { getClientPortalRepo, portalIds } from "../../../../../../../src/server/client-portal-db";
import { getActor } from "../../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { getInspectionRepo } from "../../../../../../../src/server/inspection-db";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ kind: string; id: string }> };

/**
 * Downloads one of the caller's own documents as a PDF attachment. The caller must be the buyer who made the offer or the owner of its
 * listing (offers), or someone the inspection report is shared with, its manager or its inspector (reports). Anyone else gets 404, the same
 * answer as a document that does not exist. Signed copies keep their own route (/api/signing-documents/:id/pdf).
 */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { kind, id } = await params;
  const denied = portalAccess(actor);
  if (denied) return failure(denied);
  const printedAt = portalIds.now();
  let bytes: Uint8Array | undefined;
  if (kind === "offer") {
    const r = await offerDownload(getClientPortalRepo(), actor, id, printedAt);
    if (!r.ok) return failure(r);
    bytes = r.value;
  } else if (kind === "inspection" && isUuid(id)) {
    const r = await getReport(getInspectionRepo(), actor, id);
    if (!r.ok) return failure(r);
    bytes = buildInspectionPdf(r.value, printedAt);
  }
  if (!bytes) return failure({ ok: false, code: "not_found", message: "Document not found." });
  return new NextResponse(bytes as BodyInit, { headers: {
    "content-type": "application/pdf", "content-length": String(bytes.length), "content-disposition": `attachment; filename="${kind}-${id}.pdf"`,
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store"
  } });
}

export const GET = withApi(handleGet);
