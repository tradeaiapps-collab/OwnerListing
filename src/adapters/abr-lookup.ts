import { normaliseAbn, type AbnLookupPort, type AbnRecord } from "../domain/abn";

type FetchLike = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * Real ABN Lookup (Australian Business Register, free web service). The access key (GUID) comes from the
 * environment, never from code. Returns null when the ABN is not on the register; throws when the register cannot
 * be reached, so the caller hands the case to an admin.
 */
export function createAbrLookup(guid: string, fetchFn: FetchLike = (u) => fetch(u)): AbnLookupPort {
  if (guid.trim() === "") throw new Error("An ABN Lookup access key is required.");
  return {
    async lookup(abn: string): Promise<AbnRecord | null> {
      const n = normaliseAbn(abn);
      if (n === null) return null;
      const url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${n}&callback=cb&guid=${encodeURIComponent(guid)}`;
      const res = await fetchFn(url);
      if (!res.ok) throw new Error("ABN register unavailable.");
      const body = await res.text();
      const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(body.trim()); // the service replies in callback form
      if (m === null || m[1] === undefined) throw new Error("Unexpected ABN register reply.");
      const j = JSON.parse(m[1]) as { Abn?: string; AbnStatus?: string; EntityName?: string; Message?: string };
      if (j.Message && j.Message.trim() !== "") {
        if (/search text is not a valid ABN|no records/i.test(j.Message)) return null;
        throw new Error("ABN register error.");
      }
      if (!j.Abn) return null;
      return { abn: j.Abn, active: j.AbnStatus === "Active", entityName: j.EntityName ?? "" };
    }
  };
}
