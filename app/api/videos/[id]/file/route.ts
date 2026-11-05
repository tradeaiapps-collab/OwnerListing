import { NextResponse } from "next/server";
import { canWatch } from "../../../../../src/domain/listing-video";
import { getActor } from "../../../../../src/server/context";
import { getVideoRepo, getVideoStorage } from "../../../../../src/server/listing-video-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Streams the stored video after the access check (public + published listing, owner, appointed agent, paying team, or the buyer who paid). Supports one byte range so seeking works. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const repo = getVideoRepo();
  const v = await repo.video((await params).id);
  const listing = v ? await repo.listing(v.listingId) : undefined;
  if (!v || !listing || !v.storageKey || !(await canWatch(repo, await getActor(req), v, listing))) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  const storage = getVideoStorage();
  if (!storage.configured) return NextResponse.json({ error: "File storage is not configured." }, { status: 503 });
  const bytes = await storage.get(v.storageKey);
  const type = v.contentType ?? "video/mp4";
  const priv = v.visibility === "public" && listing.status === "published" ? "public, max-age=3600" : "private, max-age=3600";
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (m && (m[1] || m[2])) {
    const size = bytes.byteLength;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new NextResponse(bytes.slice(start, end + 1) as BodyInit, {
      status: 206, headers: { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1), "cache-control": priv, "x-content-type-options": "nosniff" }
    });
  }
  return new NextResponse(bytes as BodyInit, { headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(bytes.byteLength), "cache-control": priv, "x-content-type-options": "nosniff" } });
}
export const GET = withApi(handleGet);
