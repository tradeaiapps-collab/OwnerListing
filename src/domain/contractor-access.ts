import { resolveApiPath } from "../server/api/version";

/**
 * What a contractor ("vendor") session may reach. Contractors work only on their own profile, jobs, calendar, uploads and emergency
 * settings; they are never owners, agents or buyers, so every other API answers as if signed out. Pure: one place to grow the list.
 *
 * The check is on the API path of the request (see actorFromRequestChecked), so a route added later is closed to contractors until
 * it is listed here. Pages use the same list only to decide which links to show; the API is what protects the data.
 */
export const VENDOR_API_PREFIXES: readonly string[] = [
  "/api/contractor-page",
  "/api/contractor-profile",
  "/api/jobs",
  "/api/inspector",
  "/api/notifications",
  "/api/push",
  "/api/abn",
  // Later contractor packages: calendar, uploads by job, emergency settings.
  "/api/contractor/"
];

/** True when a contractor session may call this API path. `/api/v1/...` is the same route as `/api/...`. Path traversal and encoded dots are refused. */
export function vendorMayCall(pathname: string): boolean {
  if (/%2e|%2f|%5c|\\|\.\./i.test(pathname)) return false;
  const api = resolveApiPath(pathname);
  if (api.kind !== "legacy" && api.kind !== "versioned") return false;
  const path = api.path;
  return VENDOR_API_PREFIXES.some(p => (p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));
}

export const CONTRACTOR_HOME = "/contractor/profile";
