import { SITE_ASSET_NAMES, type SiteAssetName } from "../../../../../src/domain/site-asset";
import { getDb } from "../../../../../src/server/context";
import { loadAssetFile } from "../../../../../src/server/site-theme-db";
import { PREVIEW_PARAM, verifyPreviewToken } from "../../../../../src/server/theme-preview";
import { withApi } from "../../../../../src/server/api/with-api";

const BASE = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "content-disposition": "inline",
  "cross-origin-resource-policy": "cross-origin"
};
const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

/**
 * Public logo or favicon, keyed by image id (?v=<id>). Content type is fixed from the allow-list stored with the file, never from the request.
 * A published image is immutable (the id changes when the image changes), so it is cached for a year. An image not yet used by the
 * published version is served only with a valid preview token, and then never cached.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!(SITE_ASSET_NAMES as readonly string[]).includes(name)) return notFound();
  const url = new URL(req.url);
  const v = url.searchParams.get("v") ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(v)) return notFound();
  const token = url.searchParams.get(PREVIEW_PARAM);
  const previewing = token !== null && verifyPreviewToken(token, process.env["THEME_PREVIEW_SECRET"], Math.floor(Date.now() / 1000)) !== null;
  let file;
  try {
    file = await loadAssetFile(getDb(), name as SiteAssetName, Number(v), previewing ? "draft" : "published");
  } catch {
    return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!file) return notFound();
  const etag = `"${file.sha256}"`;
  const cache = previewing ? "private, no-store" : "public, max-age=31536000, immutable";
  if (!previewing && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...BASE, etag, "cache-control": cache } });
  return new Response(new Uint8Array(file.bytes), {
    status: 200, headers: { ...BASE, "content-type": file.contentType, "content-length": String(file.bytes.length), etag, "cache-control": cache }
  });
}

export const GET = withApi(handleGet);
