import { NextResponse } from "next/server";
import { inspectSiteAsset, MAX_ASSET_BYTES } from "../../../../../src/domain/site-asset";
import { getDb } from "../../../../../src/server/context";
import { MAX_UPLOAD_BODY_BYTES, NO_STORE, readBoundedJson } from "../../../../../src/server/site-route";
import { fail } from "../../../../../src/server/staff-route";
import { getTenantForTeam, insertAsset, loadAssetFile } from "../../../../../src/server/white-label-db";
import { managerGate } from "../../../../../src/server/white-label-route";
import { withApi } from "../../../../../src/server/api/with-api";

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SLOTS = ["logo-light", "favicon"] as const;
const BASE = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline", "cache-control": "private, no-store" };

/** GET ?teamId=&slot=: the manager's own view of the current logo (so a draft logo can be seen before the brand is live). */
async function handleGet(req: Request) {
  const u = new URL(req.url);
  const gate = await managerGate(req, u.searchParams.get("teamId"));
  if (gate instanceof NextResponse) return gate;
  const slot = u.searchParams.get("slot");
  if (!SLOTS.includes(slot as never)) return fail(404, "Not found.");
  const t = await getTenantForTeam(getDb(), gate.teamId);
  const id = slot === "logo-light" ? t?.logoLightId : t?.faviconId;
  const file = t && id ? await loadAssetFile(getDb(), t.id, slot as "logo-light" | "favicon", id) : null;
  return file ? new Response(new Uint8Array(file.bytes), { headers: { ...BASE, "content-type": file.contentType } }) : fail(404, "Not found.");
}

/** POST { teamId, slot: "logo-light" | "favicon", contentType, data: base64 }. Same byte-level checks as the platform logo (PNG, JPEG, WebP, ICO for the favicon; never SVG). Save the brand first. */
async function handlePost(req: Request) {
  const body = await readBoundedJson(req, MAX_UPLOAD_BODY_BYTES);
  if (body instanceof NextResponse) return body;
  const gate = await managerGate(req, body["teamId"]);
  if (gate instanceof NextResponse) return gate;
  const slot = body["slot"];
  if (!SLOTS.includes(slot as never)) return fail(400, "slot must be logo-light or favicon.");
  const data = body["data"];
  if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4 || !B64.test(data)) return fail(400, "Send the image as base64 text, at most 512 KB.");
  const bytes = Buffer.from(data, "base64");
  const check = inspectSiteAsset(slot, body["contentType"], bytes);
  if (!check.ok) return fail(400, check.error);
  const t = await getTenantForTeam(getDb(), gate.teamId);
  if (!t) return fail(409, "Save the brand name and colours first.");
  const id = await insertAsset(getDb(), t.id, gate.userId, { slot: slot as "logo-light" | "favicon", contentType: check.contentType, bytes, width: check.width, height: check.height });
  return NextResponse.json({ id, slot, width: check.width, height: check.height }, { status: 201, headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
