import { NextResponse } from "next/server";
import { cardPhoto } from "../../../src/domain/listing-photos";
import { MAX_SEARCH_TEXT, parseSearchQuery, searchWords } from "../../../src/domain/listing-search";
import { searchPublished, toPublicListing } from "../../../src/domain/listing-service";
import type { PhotoStore } from "../../../src/domain/photo-service";
import { getDb, getDeps } from "../../../src/server/context";
import { getInvestmentDeps } from "../../../src/server/investments-db";
import { createPgPhotoStore } from "../../../src/server/photos-db";
import { publicBrowse } from "../../../src/domain/investment-service";
import { withApi } from "../../../src/server/api/with-api";

const TOP = 5;

/**
 * The search bar's quick results: ?q=words. Listings (the same filters as /api/listings also apply) and, while the investor module
 * is live, approved investment projects. Agents are not searched: the site does not publish who lists a property, so a name search
 * would reveal people it hides today.
 */
async function handleGet(req: Request) {
  const params = new URL(req.url).searchParams;
  const text = params.get("q")?.trim() ?? "";
  const words = searchWords(text);
  if (words.length === 0 || text.length > MAX_SEARCH_TEXT) return NextResponse.json({ error: "Type a word to search for." }, { status: 400 });

  const query = { ...parseSearchQuery(params), page: 1, pageSize: TOP };
  const page = await searchPublished(getDeps(), query);
  let covers: Awaited<ReturnType<PhotoStore["coversFor"]>> = new Map();
  try { covers = await createPgPhotoStore(getDb()).coversFor(page.items.map(l => l.id)); } catch { /* results without photos */ }
  const listings = page.items.map(l => ({ ...toPublicListing(l), ...cardPhoto(covers.get(l.id)) }));

  let projects: Array<{ id: string; title: string; location: string; jurisdiction: string; projectType: string; stage: string }> = [];
  try {
    const deps = getInvestmentDeps();
    if ((await deps.moduleState()).live) {
      projects = (await publicBrowse(deps))
        .filter(p => { const hay = (`${p.title} ${p.location} ${p.summary} ${p.projectType}`.toLowerCase().match(/[a-z0-9]+/g) ?? []); return words.every(w => hay.some(h => h.startsWith(w))); })
        .slice(0, TOP).map(p => ({ id: p.id, title: p.title, location: p.location, jurisdiction: p.jurisdiction, projectType: p.projectType, stage: p.stage }));
    }
  } catch { /* projects are optional: a failure leaves listings alone */ }

  return NextResponse.json({ listings: { items: listings, total: page.total }, projects: { items: projects } });
}

export const GET = withApi(handleGet);
