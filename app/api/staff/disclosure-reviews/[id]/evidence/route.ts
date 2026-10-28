import { NextResponse } from "next/server";
import { getDb, getUploadPorts } from "../../../../../../src/server/context";
import { submissionEvidencePg } from "../../../../../../src/server/disclosure-config-db";
import { createPgDocumentStore } from "../../../../../../src/server/documents-db";
import { fail, staffAudit, staffGate } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/**
 * The evidence file for a disclosure submission, for the Compliance reviewer. Every view is logged. Sent as an attachment with the
 * stored (sniffed) type and nosniff, the same as owner downloads.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "disclosure.verify");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  const db = getDb();
  const ev = await submissionEvidencePg(db, id);
  const stored = ev ? await createPgDocumentStore(db).storedFileFor(ev.documentId) : undefined;
  if (!ev || !stored) return fail(404, "No evidence file for this submission.");
  const storage = getUploadPorts().storage;
  if (!storage.configured) return fail(503, "File storage is not configured.");
  let bytes: Uint8Array;
  try { bytes = await storage.get(stored.storageKey); } catch { return fail(503, "The file could not be read right now."); }
  await staffAudit(staff, "document", ev.documentId, "staff.disclosure_evidence_viewed", { submissionId: id, listingId: ev.listingId });
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "content-type": stored.contentType, "content-length": String(bytes.length), "content-disposition": "attachment",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store"
    }
  });
}

export const GET = withApi(handleGet);
