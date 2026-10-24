import { validateAbn, type AbnLookupPort, type AbnRecord } from "../domain/abn";

type FetchInit = { redirect: "error"; signal: AbortSignal; headers: Record<string, string> };
type FetchLike = (url: string, init: FetchInit) => Promise<{ ok: boolean; text(): Promise<string> }>;

const HOST_URL = "https://abr.business.gov.au/json/AbnDetails.aspx"; // fixed host: never built from input
const TIMEOUT_MS = 8000;
const MAX_BODY = 64 * 1024;

/**
 * Real ABN Lookup (Australian Business Register, free JSON web service, JSONP reply). The access key (GUID) comes from
 * the environment, never from code. Returns null when the ABN is not on the register; throws a fixed, GUID-free
 * message when the register cannot be reached or answers oddly, so the caller hands the case to staff.
 */
export function createAbrLookup(guid: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): AbnLookupPort {
  const key = guid.trim();
  if (key === "") throw new Error("An ABN Lookup access key is required.");
  return {
    async lookup(abn: string): Promise<AbnRecord | null> {
      const v = validateAbn(abn);
      if (!v.ok) return null;
      const url = `${HOST_URL}?${new URLSearchParams({ abn: v.abn, callback: "callback", guid: key }).toString()}`;
      let body: string;
      try {
        const res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "*/*" } });
        if (!res.ok) throw new Error("not ok");
        body = await res.text();
      } catch {
        throw new Error("ABN register unavailable."); // never pass the original error on: it may carry the URL
      }
      return parseAbrReply(body, v.abn);
    }
  };
}

/** Parses the JSONP reply defensively. Exported for tests. */
export function parseAbrReply(body: string, requestedAbn: string): AbnRecord | null {
  const bad = () => new Error("Unexpected ABN register reply.");
  if (typeof body !== "string" || body.length > MAX_BODY) throw bad();
  const m = /^callback\(([\s\S]*)\)\s*;?$/.exec(body.trim());
  if (m === null || m[1] === undefined) throw bad();
  let j: unknown;
  try { j = JSON.parse(m[1]); } catch { throw bad(); }
  if (typeof j !== "object" || j === null || Array.isArray(j)) throw bad();
  const o = j as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const message = str("Message").trim();
  if (message !== "") {
    if (/search text is not a valid ABN|no records/i.test(message)) return null;
    throw new Error("ABN register error."); // the message is not passed on
  }
  const abn = str("Abn").replace(/\s+/g, "");
  if (abn === "") return null;
  if (abn !== requestedAbn) throw bad();
  const gst = o["Gst"];
  return {
    abn,
    active: str("AbnStatus") === "Active",
    entityName: str("EntityName").slice(0, 300),
    gstRegistered: typeof gst === "string" && gst.trim() !== "" ? true : gst === null || gst === "" ? false : undefined
  };
}

/** Builds the lookup from ABN_LOOKUP_GUID. Returns null when unset: callers then record "format valid, not confirmed" (fails closed). */
export function abrLookupFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchLike): AbnLookupPort | null {
  const guid = (env.ABN_LOOKUP_GUID ?? "").trim();
  return guid === "" ? null : createAbrLookup(guid, fetchFn);
}
