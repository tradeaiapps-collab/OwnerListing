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
