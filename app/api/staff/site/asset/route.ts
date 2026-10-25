import { NextResponse } from "next/server";
import { cleanIdImage } from "../../../../../src/domain/id-image";
import { inspectSiteAsset, maxAssetBytes, type SiteAssetName } from "../../../../../src/domain/site-asset";
import { getDb } from "../../../../../src/server/context";
import { MAX_UPLOAD_BODY_BYTES, NO_STORE, readBoundedJson } from "../../../../../src/server/site-route";
import { insertAsset } from "../../../../../src/server/site-theme-db";
import { fail, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Uploads a logo, favicon or home hero photo. Body: { name: "logo-light" | "logo-dark" | "favicon" | "hero", contentType, data: base64 }.
 * Type, size and dimensions are checked from the bytes (PNG, JPEG, WebP, ICO for the favicon; never SVG); the declared type must match.
 * The hero photo is first rewritten without its EXIF, XMP and text metadata (camera, GPS), with the same cleaner as ID photos.
 * Returns the new image id to put in the settings; the file is public only once a published version uses it.
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_UPLOAD_BODY_BYTES);
  if (body instanceof NextResponse) return body;
  const data = body["data"];
  const hero = body["name"] === "hero";
  const maxB64 = Math.ceil(maxAssetBytes(hero ? "hero" : "logo-light") / 3) * 4 + 4;
  if (typeof data !== "string" || data.length === 0 || data.length > maxB64 || !B64.test(data)) return fail(400, `Send the image as base64 text, at most ${hero ? "1.5 MB" : "512 KB"}.`);
  let bytes = Buffer.from(data, "base64");
  if (hero) {
    const cleaned = cleanIdImage(bytes);
    if (!cleaned.ok) return fail(400, "The hero photo must be a JPEG, PNG or WebP whose metadata can be removed. Export it again (for example Save for web) and retry.");
    bytes = Buffer.from(cleaned.bytes);
  }
  const check = inspectSiteAsset(body["name"], body["contentType"], bytes);
  if (!check.ok) return fail(400, check.error);
  const name = body["name"] as SiteAssetName;
  const id = await insertAsset(getDb(), staff, { name, contentType: check.contentType, bytes, width: check.width, height: check.height });
  return NextResponse.json({ id, name, contentType: check.contentType, width: check.width, height: check.height, bytes: bytes.length }, { status: 201, headers: NO_STORE });
}

export const POST = withApi(handlePost);
