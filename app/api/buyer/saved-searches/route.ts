import { NextResponse } from "next/server";
import { createSavedSearch, parseSavedSearchInput } from "../../../../src/domain/saved-search-service";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getSavedSearchRepo } from "../../../../src/server/saved-search-context";
import { csrfGuard } from "../../../../src/server/csrf";

/** The signed-in user's own saved searches. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ searches: await getSavedSearchRepo().list(actor.userId) });
}

/** Saves a search of property facts for the signed-in user. Saving a search does not turn on alerts; that needs consent. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseSavedSearchInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const r = await createSavedSearch(getSavedSearchRepo(), actor.userId, parsed.value);
  return r.ok ? NextResponse.json({ search: r.value }, { status: 201 }) : failure(r);
}
