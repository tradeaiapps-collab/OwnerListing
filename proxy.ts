import { NextResponse, type NextRequest } from "next/server";
import { isAllowed, readAppMode } from "./src/config/app-mode";
import { readCookie } from "./src/server/auth/session";

/** Enforces APP_MODE: routes that do not belong to this deployment answer 404 (not 403, so their existence is not revealed). */
export function proxy(req: NextRequest) {
  const mode = readAppMode();
  const { pathname, searchParams } = req.nextUrl;
  if (mode === "admin" && pathname === "/") return NextResponse.redirect(new URL("/staff", req.url));
  if (isAllowed(mode, pathname, searchParams.get("as"), readCookie(req, "ol_role"))) return NextResponse.next();
  return new NextResponse("Not found", { status: 404 });
}

// Match every path. A matcher that skips /_next/static by prefix would also skip /_next/static/..%2fstaff; isAllowed decides what is static.
export const config = { matcher: ["/:path*"] };
