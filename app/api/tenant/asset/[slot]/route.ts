import { getDb } from "../../../../../src/server/context";
import { requestHost, tenantForHost } from "../../../../../src/server/white-label";
import { loadAssetFile } from "../../../../../src/server/white-label-db";
import { withApi } from "../../../../../src/server/api/with-api";

const BASE = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline", "cross-origin-resource-policy": "cross-origin" };
const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

/**
 * The logo or favicon of the white-label agency that owns this request's host (?v=<image id>). Only an active tenant's current image is served,
 * and only when v matches it, so the response for a given URL never changes and may be cached for a year. Content type comes from the stored allow-list value.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ slot: string }> }) {
  const { slot } = await ctx.params;
  if (slot !== "logo-light" && slot !== "favicon") return notFound();
  const v = new URL(req.url).searchParams.get("v") ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(v)) return notFound();
  const tenant = await tenantForHost(requestHost(req.headers));
  if (!tenant) return notFound();
  let file;
  try { file = await loadAssetFile(getDb(), tenant.id, slot, Number(v)); } catch { return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } }); }
  if (!file) return notFound();
  const etag = `"${file.sha256}"`;
  const cache = "public, max-age=31536000, immutable";
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...BASE, etag, "cache-control": cache } });
  return new Response(new Uint8Array(file.bytes), { status: 200, headers: { ...BASE, "content-type": file.contentType, "content-length": String(file.bytes.length), etag, "cache-control": cache } });
}
export const GET = withApi(handleGet);
