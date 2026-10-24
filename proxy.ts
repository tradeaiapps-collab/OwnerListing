import { NextResponse, type NextRequest } from "next/server";
import { isAllowed, readAppMode } from "./src/config/app-mode";
import { readCookie } from "./src/server/auth/session";

/** Enforces APP_MODE: routes that do not belong to this deployment answer 404 (not 403, so their existence is not revealed). */
export function proxy(req: NextRequest) {
  const mode = readAppMode();
  const { pathname, searchParams } = req.nextUrl;
  if (mode === "admin" && pathname === "/") return NextResponse.redirect(new URL("/staff", req.url));
  if (!isAllowed(mode, pathname, searchParams.get("as"), readCookie(req, "ol_role"))) return new NextResponse("Not found", { status: 404 });
  return withThemePreview(req);
}

const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{1,400}$/;
const PREVIEW_COOKIE = "ol_theme_preview";

/**
 * Passes a theme preview token (?theme_preview= or the cookie it sets, 15 minutes) to the layout as a request header. A client-sent
 * x-theme-preview header is always discarded. The layout verifies the signature; here the token is only shape-checked.
 */
function withThemePreview(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete("x-theme-preview");
  const fromQuery = req.nextUrl.searchParams.get("theme_preview");
  const token = [fromQuery, readCookie(req, PREVIEW_COOKIE)].find(t => t && TOKEN_SHAPE.test(t));
  if (!token) return NextResponse.next({ request: { headers } });
  headers.set("x-theme-preview", token);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("cache-control", "private, no-store");
  if (fromQuery === token) {
    const secure = req.nextUrl.protocol === "https:";
    res.cookies.set(PREVIEW_COOKIE, token, { httpOnly: true, path: "/", maxAge: 15 * 60, secure, sameSite: secure ? "none" : "lax" });
  }
  return res;
}

// Match every path. A matcher that skips /_next/static by prefix would also skip /_next/static/..%2fstaff; isAllowed decides what is static.
export const config = { matcher: ["/:path*"] };
