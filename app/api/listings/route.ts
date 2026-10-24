import { NextResponse } from "next/server";
import { isJurisdiction } from "../../../src/domain/jurisdiction";
import {
  createDraft, parseDraftInput, searchPublished, toPublicListing,
  TRANSACTION_TYPES, USE_CLASSES, type SearchFilters
} from "../../../src/domain/listing-service";
import { forbiddenFor } from "../../../src/domain/access";
import { getActor, getDeps } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";

/** Public search over published listings. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const filters: SearchFilters = {};
  const j = q.get("jurisdiction");
  const tx = q.get("transactionType");
  const use = q.get("useClass");
  if (j && isJurisdiction(j)) filters.jurisdiction = j;
  const txMatch = TRANSACTION_TYPES.find(t => t === tx);
  if (txMatch) filters.transactionType = txMatch;
  const useMatch = USE_CLASSES.find(u => u === use);
  if (useMatch) filters.useClass = useMatch;
  return NextResponse.json({ listings: (await searchPublished(getDeps(), filters)).map(toPublicListing) });
}

/** Creates a draft owned by the signed-in user. */
export async function POST(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.create");
  if (denied) return failure(denied);
  const parsed = parseDraftInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  return NextResponse.json({ listing: await createDraft(getDeps(), actor, parsed.value) }, { status: 201 });
}
