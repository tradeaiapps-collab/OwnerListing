import { NextResponse } from "next/server";
import { getDb, getUploadPorts } from "../../../../../../src/server/context";
import { documentKeyFor } from "../../../../../../src/server/prequalification-db";
import { fail, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The buyer's PDF, for staff with the review permission only. Every view is logged. Served as an attachment, never inline. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "prequal.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const key = await documentKeyFor(getDb(), id);
  const { storage } = getUploadPorts();
  if (!key) return fail(404, "Not found.");
  if (!storage.configured) return fail(503, "File storage is not configured.");
  let bytes: Uint8Array;
  try { bytes = await storage.get(key); } catch { return fail(503, "The file could not be read right now."); }
  await staffAudit(staff, "prequalification", id, "prequal.document_viewed", {});
  return new NextResponse(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="pre-approval.pdf"', "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}

export const GET = withApi(handleGet);
