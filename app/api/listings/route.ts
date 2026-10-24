import { NextResponse } from "next/server";
import { createDraft, parseDraftInput, searchPublished, toPublicListing } from "../../../src/domain/listing-service";
import { parseSearchQuery } from "../../../src/domain/listing-search";
import { forbiddenFor } from "../../../src/domain/access";
import { getActor, getDeps } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { csrfGuard } from "../../../src/server/csrf";
import { requireCurrentTerms } from "../../../src/server/terms-guard";

/** Public browse over published listings: filters, sort and pages (see parseSearchQuery for the parameters). */
export async function GET(req: Request) {
  const query = parseSearchQuery(new URL(req.url).searchParams);
  const page = await searchPublished(getDeps(), query);
  return NextResponse.json({ listings: page.items.map(toPublicListing), total: page.total, page: page.page, pageSize: page.pageSize });
}

/** Creates a draft owned by the signed-in user. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.create");
  if (denied) return failure(denied);
  const noTerms = await requireCurrentTerms(getDeps().termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const parsed = parseDraftInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  return NextResponse.json({ listing: await createDraft(getDeps(), actor, parsed.value) }, { status: 201 });
}
