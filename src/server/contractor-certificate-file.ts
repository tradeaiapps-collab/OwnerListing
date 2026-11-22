import { NextResponse } from "next/server";
import { certificateFilePg } from "./contractor-certificates-db";
import { err, ID_RE } from "./contractor-trust-route";
import { getDb, getUploadPorts } from "./context";


/** Always an attachment with the sniffed type and nosniff, so an uploaded file can never run as a page in our origin. */
export async function sendCertificate(id: string, ownerId: string | null) {
  if (!ID_RE.test(id)) return err(404, "File not found.");
  const f = await certificateFilePg(getDb(), id, ownerId);
  if (!f) return err(404, "File not found.");
  let bytes: Uint8Array;
  try { bytes = await getUploadPorts().storage.get(f.storageKey); } catch { return err(503, "The file is not available right now."); }
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "content-type": f.contentType, "content-length": String(bytes.length), "content-disposition": "attachment", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store"
    }
  });
}
