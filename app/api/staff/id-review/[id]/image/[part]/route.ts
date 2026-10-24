import { NextResponse } from "next/server";
import { viewIdImage } from "../../../../../../../src/server/id-image";
import { fail, staffGate, UUID_RE } from "../../../../../../../src/server/staff-route";
import { getIdImageDeps } from "../../../../../../../src/server/verification-context";

const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "content-disposition": "inline",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin"
};
const CHUNK = 64 * 1024;

/**
 * Streams one decrypted ID image to the reviewer who holds the live claim (30 minutes). Every view is written to
 * id_review_access (reviewer id and part) before any byte is read. Everyone else, including the buyer, gets 404.
 * Never cached (no-store). There is no buyer download route.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; part: string }> }) {
  const staff = await staffGate(req, "identity.review");
  if (staff instanceof NextResponse) return staff;
  const { id, part } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const r = await viewIdImage(getIdImageDeps(), staff.id, id, part);
  if (!r.ok) return r.code === "unavailable" ? fail(503, r.message) : fail(404, "Not found.");
  const bytes = r.value.bytes;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) { bytes.fill(0); c.close(); return; }
      c.enqueue(bytes.slice(at, at + CHUNK));
      at += CHUNK;
    }
  });
  return new Response(body, { status: 200, headers: { ...HEADERS, "content-type": r.value.mime, "content-length": String(bytes.length) } });
}
