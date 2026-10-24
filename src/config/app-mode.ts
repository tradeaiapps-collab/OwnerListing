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

const STATIC = /^\/(_next\/|favicon\.ico$|robots\.txt$)/;
const isStaffPath = (p: string) => p === "/staff" || p.startsWith("/staff/") || p === "/api/staff" || p.startsWith("/api/staff/");
const AUTH_START = "/api/auth/google/start";
const AUTH_CALLBACK = "/api/auth/google/callback";

/**
 * Whether a request may be served in this mode. `as` is the ?as= query value; `role` is the ol_role cookie that sign-in start sets.
 * public: no staff pages, staff APIs or staff sign-in. admin: only staff pages/APIs, staff sign-in, logout, health and static assets.
 */
export function isAllowed(mode: AppMode, pathname: string, as: string | null, role: string | undefined): boolean {
  if (mode === "all" || STATIC.test(pathname) || pathname === "/api/health") return true;
  const staffSignIn = (pathname === AUTH_START && as === "staff") || (pathname === AUTH_CALLBACK && role === "staff");
  if (mode === "public") return !isStaffPath(pathname) && !staffSignIn;
  return isStaffPath(pathname) || staffSignIn || pathname === "/api/auth/logout";
}
