import { NextResponse } from "next/server";
import { OPTIMIZATION_NOTE, isSellerStatus } from "../../../../../src/domain/listing-optimization";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getOptimizationSettings, listSuggestions, setSuggestionStatus } from "../../../../../src/server/listing-optimization-db";
import { optimizeListing } from "../../../../../src/server/listing-optimization-service";
import { requireListingOwner } from "../../../../../src/server/owner-listing";
import { noStore } from "../../../../../src/server/property-intelligence";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const off = () => NextResponse.json({ error: "Listing optimization is not available." }, { status: 404, headers: noStore });

/** The listing owner's suggestions, freshly worked out. Owner only (everyone else gets 404); 404 while the feature is off for the site. */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const owner = await requireListingOwner(req, id);
  if (owner instanceof NextResponse) return owner;
  const settings = await getOptimizationSettings(getDb());
  if (!settings.enabled) return off();
  const suggestions = await optimizeListing(getDb(), owner.rec.listing, settings, getDeps().now());
  return NextResponse.json({ suggestions, note: OPTIMIZATION_NOTE }, { headers: noStore });
}

/** Body { suggestionId, status: "implemented" | "dismissed" | "open" }: the seller's answer to one suggestion. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await params;
  const owner = await requireListingOwner(req, id);
  if (owner instanceof NextResponse) return owner;
  const db = getDb();
  if (!(await getOptimizationSettings(db)).enabled) return off();
  const body = await req.json().catch(() => ({})) as { suggestionId?: unknown; status?: unknown };
  if (typeof body.suggestionId !== "string" || !UUID.test(body.suggestionId) || !isSellerStatus(body.status)) {
    return NextResponse.json({ error: "Send a suggestionId and a status of implemented, dismissed or open." }, { status: 400, headers: noStore });
  }
  const now = getDeps().now();
  if (!(await setSuggestionStatus(db, id, body.suggestionId, body.status, now))) return NextResponse.json({ error: "Suggestion not found." }, { status: 404, headers: noStore });
  return NextResponse.json({ suggestions: await listSuggestions(db, id, now), note: OPTIMIZATION_NOTE }, { headers: noStore });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
