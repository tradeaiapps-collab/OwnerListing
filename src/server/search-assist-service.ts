import type { AiEnginePort } from "../domain/ai-engine";
import { compareProperties, parseCompareIds } from "../domain/listing-compare";
import { MAX_SEARCH_TEXT, parseSearchQuery } from "../domain/listing-search";
import { searchPublished, toPublicListing, type ListingServiceDeps, type PublicListing } from "../domain/listing-service";
import { analyseListings, explainSearchFeature, interpretSearch, MAX_ASSIST_TEXT, narrate, relaxations, SEARCH_ASSIST_NOTE } from "../domain/search-assist";

/** How many matching listings Elena reads for the figures. Enough for a fair spread, small enough to answer fast. */
export const ASSIST_SAMPLE = 50;
export const MAX_QUERY_STRING = 600;

export type AssistResult = { status: 200; body: Record<string, unknown> } | { status: 400 | 404; body: { error: string } };
const bad = (error: string, status: 400 | 404 = 400): AssistResult => ({ status, body: { error } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Elena's search help, one request. Public: it reads only published listings and never any account.
 * Body: { mode: "interpret", text } | { mode: "explain", text } | { mode: "analyse", query } | { mode: "compare", ids }.
 * `query` is a URL query string of the same filters as /api/listings. The AI engine, when on, only rewords the rule-based facts.
 */
export async function runSearchAssist(body: unknown, deps: ListingServiceDeps, engine: AiEnginePort): Promise<AssistResult> {
  if (!isObj(body)) return bad("Send a JSON object.");
  const mode = body["mode"];

  if (mode === "interpret" || mode === "explain") {
    const text = body["text"];
    if (typeof text !== "string" || text.trim() === "") return bad("Tell me what you are looking for.");
    if (text.length > MAX_ASSIST_TEXT) return bad(`Please keep it under ${MAX_ASSIST_TEXT} characters.`);
    if (mode === "explain") return { status: 200, body: { mode, ...explainSearchFeature(text) } };
    const r = interpretSearch(text);
    return { status: 200, body: { mode, params: r.params, understood: r.understood, note: r.understood.length === 0
      ? "I couldn't find a filter in that. Try something like \"3 bed house in Paddington under 900k with a pool\"." : "Check the filters I set, then press Search." } };
  }

  if (mode === "analyse") {
    const qs = body["query"] === undefined ? "" : body["query"];
    if (typeof qs !== "string" || qs.length > MAX_QUERY_STRING) return bad("Send the search filters as a query string.");
    const base = parseSearchQuery(new URLSearchParams(qs.replace(/^\?/, "")));
    const page = await searchPublished(deps, { ...base, page: 1, pageSize: ASSIST_SAMPLE });
    const analysis = analyseListings(page.items, page.total, base.near);
    const out: Record<string, unknown> = { mode, analysis, note: SEARCH_ASSIST_NOTE };
    if (page.total === 0) {
      const tries: Array<{ label: string; count: number; clear: string[] }> = [];
      for (const r of relaxations(base).slice(0, 8)) {
        const c = (await searchPublished(deps, r.query)).total;
        if (c > 0) tries.push({ label: r.label, count: c, clear: r.clear });
      }
      out["relaxations"] = tries.sort((a, b) => b.count - a.count).slice(0, 3);
    } else {
      const words = await narrate(engine, analysis.text);
      if (words) out["narration"] = words;
    }
    return { status: 200, body: out };
  }

  if (mode === "compare") {
    const ids = parseCompareIds(Array.isArray(body["ids"]) ? body["ids"].join(",") : typeof body["ids"] === "string" ? body["ids"] : null);
    if (!ids) return bad("Pick 2 to 4 different listings to compare.");
    const found = await loadPublished(deps, ids);
    if (!found) return bad("One of those listings is no longer available.", 404);
    const comparison = compareProperties(found);
    const words = await narrate(engine, comparison.summary);
    return { status: 200, body: { mode, comparison, ...(words ? { narration: words } : {}), note: SEARCH_ASSIST_NOTE } };
  }
  return bad("Unknown request.");
}

/** The published listings for these ids in the same order, or undefined if any is missing, unpublished or not found. */
export async function loadPublished(deps: ListingServiceDeps, ids: string[]): Promise<PublicListing[] | undefined> {
  const recs = await Promise.all(ids.map(id => deps.repo.get(id)));
  if (recs.some(r => !r || r.listing.status !== "published")) return undefined;
  return recs.map(r => toPublicListing(r!.listing));
}
export { MAX_SEARCH_TEXT };
