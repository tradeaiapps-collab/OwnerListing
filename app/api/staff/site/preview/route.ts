import { NextResponse } from "next/server";
import { appOriginFor, readAppMode } from "../../../../../src/config/app-mode";
import { NO_STORE } from "../../../../../src/server/site-route";
import { fail, staffGate } from "../../../../../src/server/staff-route";
import { PREVIEW_PARAM, PREVIEW_TTL_SECONDS, signPreviewToken } from "../../../../../src/server/theme-preview";

/**
 * Issues a signed preview token (15 minutes) and the public-site address that shows the draft with it. Staff with theme.edit only.
 * Fails closed when THEME_PREVIEW_SECRET (32+ characters, the same value on the public and admin sites) is not set.
 */
export async function POST(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const secret = process.env["THEME_PREVIEW_SECRET"];
  if (!secret || secret.length < 32) return fail(503, "Preview is off: set THEME_PREVIEW_SECRET (32+ characters, same value on the public and admin sites).");
  const origin = readAppMode() === "admin" ? appOriginFor("public") : "";
  if (origin === null) return fail(503, "Preview is off: set APP_URL on the admin site to the public site's address.");
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS;
  const token = signPreviewToken({ uid: staff.id, exp }, secret);
  return NextResponse.json({ url: `${origin}/?${PREVIEW_PARAM}=${encodeURIComponent(token)}`, origin, expiresAt: new Date(exp * 1000).toISOString() }, { headers: NO_STORE });
}
