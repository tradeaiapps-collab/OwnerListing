import { NextResponse } from "next/server";
import { getDb, getDeps } from "../../../../src/server/context";
import { buildReport, loadListingFacts } from "../../../../src/server/listing-performance-db";
import { requireListingOwner } from "../../../../src/server/owner-listing";
import { noStore } from "../../../../src/server/property-intelligence";
import { UUID_RE } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Performance of one of the signed-in owner's listings for sale (?listing=id): views, inquiries and offers over 7/30/90 days, a comparison with
 * similar listings, a day-and-time heatmap and Elena's advice, all from daily snapshots. Owner only; everyone else, including agents, gets 404.
 */
async function handleGet(req: Request) {
  const id = new URL(req.url).searchParams.get("listing") ?? "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Choose a listing." }, { status: 400, headers: noStore });
  const owner = await requireListingOwner(req, id);
  if (owner instanceof NextResponse) return owner;
  if (owner.rec.listing.transactionType !== "sale") return NextResponse.json({ error: "Performance is shown for properties for sale." }, { status: 400, headers: noStore });
  const db = getDb();
  const facts = await loadListingFacts(db, id);
  if (!facts) return NextResponse.json({ error: "Listing not found." }, { status: 404, headers: noStore });
  return NextResponse.json(await buildReport(db, facts, getDeps().now()), { headers: noStore });
}

export const GET = withApi(handleGet);
