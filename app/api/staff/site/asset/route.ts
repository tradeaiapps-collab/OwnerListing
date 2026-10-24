import { NextResponse } from "next/server";
import { inspectSiteAsset, type SiteAssetName } from "../../../../../src/domain/site-asset";
import { getDb } from "../../../../../src/server/context";
import { MAX_UPLOAD_BODY_BYTES, NO_STORE, readBoundedJson } from "../../../../../src/server/site-route";
import { insertAsset } from "../../../../../src/server/site-theme-db";
import { fail, staffGate } from "../../../../../src/server/staff-route";

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Uploads a logo or favicon. Body: { name: "logo-light" | "logo-dark" | "favicon", contentType, data: base64 }.
 * Type, size and dimensions are checked from the bytes (PNG, JPEG, WebP, ICO for the favicon; never SVG); the declared type must match.
 * Returns the new image id to put in the settings; the file is public only once a published version uses it.
 */
export async function POST(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_UPLOAD_BODY_BYTES);
  if (body instanceof NextResponse) return body;
  const data = body["data"];
  if (typeof data !== "string" || data.length === 0 || data.length > 700_000 || !B64.test(data)) return fail(400, "Send the image as base64 text, at most 512 KB.");
  const bytes = Buffer.from(data, "base64");
  const check = inspectSiteAsset(body["name"], body["contentType"], bytes);
  if (!check.ok) return fail(400, check.error);
  const name = body["name"] as SiteAssetName;
  const id = await insertAsset(getDb(), staff, { name, contentType: check.contentType, bytes, width: check.width, height: check.height });
  return NextResponse.json({ id, name, contentType: check.contentType, width: check.width, height: check.height, bytes: bytes.length }, { status: 201, headers: NO_STORE });
}
