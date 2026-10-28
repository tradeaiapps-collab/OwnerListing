/**
 * API versions. Clients call /api/v1/...; the proxy rewrites that to the route handler under /api/... and tells the handler which
 * version was asked for in VERSION_HEADER (a client-sent copy of that header is always discarded). Unversioned /api/... stays
 * the "legacy" contract the site's own pages use today, unchanged.
 *
 * Adding a version: add it to API_VERSIONS and give it its own formatting in with-api.ts. A version is never changed
 * incompatibly once released; a breaking change means a new version, and the old one keeps working.
 */
export const API_VERSIONS = ["v1"] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];
export type RequestedVersion = ApiVersion | "legacy";
export const LATEST_API_VERSION: ApiVersion = "v1";

/** Internal request header set by the proxy only. */
export const VERSION_HEADER = "x-ol-api-version";
/** Response header naming the version that answered. */
export const API_VERSION_RESPONSE_HEADER = "api-version";

export type ResolvedApiPath =
  | { kind: "not_api" }
  | { kind: "legacy"; path: string }
  | { kind: "versioned"; version: ApiVersion; path: string }
  | { kind: "unsupported"; requested: string };

const isVersion = (v: string): v is ApiVersion => (API_VERSIONS as readonly string[]).includes(v);

/** Maps a request path to the handler path and version. /api/v2/... (or any version not released) is "unsupported". Pure. */
export function resolveApiPath(pathname: string): ResolvedApiPath {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return { kind: "not_api" };
  const m = /^\/api\/(v\d+)(\/.*)?$/.exec(pathname);
  if (!m) return { kind: "legacy", path: pathname };
  const [, v, rest] = m as unknown as [string, string, string | undefined];
  if (!isVersion(v)) return { kind: "unsupported", requested: v };
  return { kind: "versioned", version: v, path: `/api${rest ?? ""}` };
}

/** The version a handler is answering, from the proxy's header. Anything unknown is legacy. */
export function requestedVersion(req: Request): RequestedVersion {
  const v = req.headers.get(VERSION_HEADER);
  return v !== null && isVersion(v) ? v : "legacy";
}
