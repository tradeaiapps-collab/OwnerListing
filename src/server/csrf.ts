import { NextResponse } from "next/server";
import { appOriginFor, readAppMode } from "../config/app-mode";
import { readSessionEnv } from "./auth/config";
import { mobileBearer, verifyMobileAccess } from "./auth/mobile-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const deny = (error: string) => NextResponse.json({ error }, { status: 403 });

const originOf = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const o = new URL(value).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
};

/**
 * CSRF guard for cookie-authenticated, state-changing routes. Call first in every POST/PUT/PATCH/DELETE handler.
 * Requires Origin (or Referer, only when Origin is absent) to equal the origin of this deployment: ADMIN_APP_URL when APP_MODE=admin,
 * otherwise APP_URL. Fails closed if that URL is unset or invalid.
 * Requires application/json unless `json: false` (routes that read no body). Returns a 403 response, or null to proceed.
 * Safe methods pass through untouched.
 */
export function csrfGuard(req: Request, opts: { json?: boolean } = {}): NextResponse | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  // The phone app sends no Origin. A request carrying its bearer token is signed in by that token alone (the cookie is ignored, see
  // sessionFromRequestChecked), and a browser cannot attach that header to a cross-site request, so the origin check does not apply.
  // Only a correctly signed, unexpired token skips it; anything else is checked like a browser request.
  const auth = readSessionEnv();
  const mobile = auth !== null && verifyMobileAccess(mobileBearer(req), auth.secret, Math.floor(Date.now() / 1000)) !== null;
  const expected = appOriginFor(readAppMode());
  if (!mobile) {
    if (!expected) return deny("Request origin could not be verified.");
    const supplied = req.headers.has("origin") ? originOf(req.headers.get("origin")) : originOf(req.headers.get("referer"));
    if (supplied !== expected) return deny("Cross-origin request denied.");
  }
  if (opts.json !== false) {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return deny("Content-Type must be application/json.");
  }
  return null;
}
