import { blockMessage, scanContent, scanFields, type ContentFlagStore, type ContentSource } from "../domain/content-filter";

/** The platform's own hosts, so a link back to the site is not treated as an outside link. */
export function platformHosts(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const h = (env["APP_URL"] ?? "").replace(/^https?:\/\//i, "").split(/[/:]/)[0]?.replace(/^www\./, "").toLowerCase();
  return h ? [h] : [];
}

export type GuardResult = { ok: true; after: (subjectId: string) => Promise<void> } | { ok: false; message: string };

const safely = async (p: Promise<void>) => { try { await p; } catch (e) { console.error("content flag not recorded", e); } };

/**
 * Checks one text (a message) or several (profile fields). Blocked text is recorded and refused. Flagged text is allowed:
 * call `after(subjectId)` once it is stored so the flag points at the stored row. A failing flag store never blocks anyone.
 */
export async function guardContent(store: ContentFlagStore, input: {
  source: ContentSource; subjectType: string; userId: string; fields: Readonly<Record<string, string>>; allowedHosts?: readonly string[];
}): Promise<GuardResult> {
  const opts = { allowedHosts: input.allowedHosts ?? platformHosts() };
  const scan = scanFields(input.fields, opts);
  const flagFor = async (action: "flag" | "block", subjectId?: string) => {
    for (const [field, s] of Object.entries(scan.byField)) {
      if (!s.hits.length) continue;
      await safely(store.record({ source: input.source, subjectType: input.subjectType, ...(subjectId ? { subjectId } : {}), field, userId: input.userId, action, hits: s.hits, excerpt: input.fields[field]!.slice(0, 500) }));
    }
  };
  if (scan.action === "block") { await flagFor("block"); return { ok: false, message: blockMessage(scan, input.source) }; }
  if (scan.action === "flag") return { ok: true, after: id => flagFor("flag", id) };
  return { ok: true, after: async () => {} };
}

export { scanContent };
