import { NextResponse, type NextRequest } from "next/server";
import { isAllowed, readAppMode } from "./src/config/app-mode";

/** Enforces APP_MODE: routes that do not belong to this deployment answer 404 (not 403, so their existence is not revealed). */
export function proxy(req: NextRequest) {
  const mode = readAppMode();
  const { pathname, searchParams } = req.nextUrl;
  if (mode === "admin" && pathname === "/") return NextResponse.redirect(new URL("/staff", req.url));
  if (isAllowed(mode, pathname, searchParams.get("as"), req.cookies.get("ol_role")?.value)) return NextResponse.next();
  return new NextResponse("Not found", { status: 404 });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
