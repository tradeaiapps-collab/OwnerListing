import type { Selection } from "./listing-bulk-db";

/** The selection in a request body: { ids: [...] } or { filter: { q, status, jurisdiction, transactionType } } ("select all, filtered"). */
export function readSelection(body: Record<string, unknown>): Selection | null {
  if (Array.isArray(body["ids"]) && body["ids"].every(i => typeof i === "string")) return { ids: body["ids"] as string[] };
  const f = body["filter"];
  if (f !== null && typeof f === "object" && !Array.isArray(f)) {
    const o = f as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string).trim().slice(0, 120) : undefined);
    const q = s("q"), status = s("status"), jurisdiction = s("jurisdiction"), transactionType = s("transactionType");
    return { filter: { ...(q ? { q } : {}), ...(status ? { status } : {}), ...(jurisdiction ? { jurisdiction } : {}), ...(transactionType ? { transactionType } : {}) } };
  }
  return null;
}
