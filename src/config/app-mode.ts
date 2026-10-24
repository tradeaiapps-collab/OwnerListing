/** APP_MODE splits one codebase into a public site and a staff-only admin site (two deployments). Unset means "all" for local dev. */
export type AppMode = "public" | "admin" | "all";

/** Unset: "all" in development, "public" in production (fail closed, so a forgotten setting never exposes the admin panel). Unknown value: "public". */
export function readAppMode(env: Record<string, string | undefined> = process.env): AppMode {
  const v = env["APP_MODE"]?.trim().toLowerCase();
  if (!v) return env["NODE_ENV"] === "production" ? "public" : "all";
  if (v === "all" || v === "admin") return v;
  return "public";
}

/** The origin this deployment is served from. Admin uses ADMIN_APP_URL; public and all use APP_URL. Null if unset or invalid (fail closed). */
export function appOriginFor(mode: AppMode, env: Record<string, string | undefined> = process.env): string | null {
  const raw = mode === "admin" ? env["ADMIN_APP_URL"] : env["APP_URL"];
  if (!raw) return null;
  try {
    const o = new URL(raw).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

// Only built assets. /_next/data and the rest of /_next/ are not exempt, so they cannot be a way around the split.
const STATIC = /^\/(_next\/static\/|_next\/image$|favicon\.ico$|robots\.txt$)/;
const SITE_ASSET = /^\/api\/site\/asset\/(logo-light|logo-dark|favicon)$/;
const isStaffPath = (p: string) => p === "/staff" || p.startsWith("/staff/") || p === "/api/staff" || p.startsWith("/api/staff/");

/**
 * Canonical form of a request path for the allow-list, or null if it cannot be made safe (then the caller answers 404).
 * NextURL.pathname keeps percent-encoding and repeated slashes (/%73taff, //staff) while the router decodes them, so decode (up to 3 rounds,
 * to cover /%2573taff), turn backslashes and repeated slashes into one slash, drop ;params and the trailing slash, and lower-case.
 */
export function normalizePath(raw: string): string | null {
  let p = raw;
  for (let i = 0; i < 3 && p.includes("%"); i++) {
    try { p = decodeURIComponent(p); } catch { return null; }
  }
  if (p.includes("%") || p.includes("\0")) return null;
  p = p.replace(/;[^/]*/g, "").replace(/[\\/]+/g, "/").toLowerCase();
  const segs: string[] = [];
  for (const s of p.split("/")) { if (s === "..") segs.pop(); else if (s !== "." && s !== "") segs.push(s); }
  return "/" + segs.join("/");
}
const AUTH_START = "/api/auth/google/start";
const AUTH_CALLBACK = "/api/auth/google/callback";
// DEV-ONLY test sign-in. Passes the proxy on both instances; the page and route answer 404 unless devLoginAllowed() (src/server/dev-login.ts).
const DEV_LOGIN_PATHS = new Set(["/dev-login", "/api/dev/login"]);

/**
 * Whether a request may be served in this mode. `as` is the ?as= query value; `role` is the ol_role cookie that sign-in start sets.
 * public: no staff pages, staff APIs or staff sign-in. admin: only staff pages/APIs, staff sign-in, logout, health and static assets.
 */
export function isAllowed(mode: AppMode, rawPathname: string, as: string | null, role: string | undefined): boolean {
  if (mode === "all") return true;
  const pathname = normalizePath(rawPathname);
  if (pathname === null) return false;
  if (STATIC.test(pathname) || pathname === "/api/health") return true;
  const staffSignIn = (pathname === AUTH_START && as === "staff") || (pathname === AUTH_CALLBACK && role === "staff");
  if (mode === "public") return !isStaffPath(pathname) && !staffSignIn;
  // The themed header on the admin site shows the same logo, so the public, read-only image route is served here too.
  return isStaffPath(pathname) || staffSignIn || pathname === "/api/auth/logout" || SITE_ASSET.test(pathname) || DEV_LOGIN_PATHS.has(pathname);
}
