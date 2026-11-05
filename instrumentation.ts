import { checkProviders } from "./src/config/provider-check.mjs";

/** Runs once when the server starts. Logs which provider keys are missing or wrong (names only, never values). Never stops the server: each feature already fails closed on its own. */
export function register() {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  for (const r of checkProviders(process.env)) {
    if (r.status === "ready") continue;
    const detail = [...(r.missing.length ? [`missing ${r.missing.join(", ")}`] : []), ...r.problems].join("; ");
    const line = `[providers] ${r.label}: ${r.status}${detail ? ` (${detail})` : ""}. ${r.whenOff}`;
    if (r.blocking) console.error(line); else console.warn(line);
  }
}

/** Next.js hook for every uncaught server error. Writes one JSON line (route, method, digest, message; no request body, headers or cookies) so Vercel logs and any log drain or error tracker can alert on it. */
export function onRequestError(err: unknown, request: { path: string; method: string }, context: { routerKind: string; routeType: string }) {
  const e = err as { message?: string; digest?: string };
  console.error(JSON.stringify({
    level: "error",
    event: "request_error",
    path: request.path.split("?")[0],
    method: request.method,
    routerKind: context.routerKind,
    routeType: context.routeType,
    digest: e?.digest,
    message: String(e?.message ?? "unknown").slice(0, 300),
  }));
}
