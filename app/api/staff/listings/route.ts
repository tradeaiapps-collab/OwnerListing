import { NextResponse } from "next/server";
import { staffCan } from "../../../../src/domain/staff-access";
import { listingActionsFor } from "../../../../src/domain/admin-moderation";
import { getDb } from "../../../../src/server/context";
import { searchListings } from "../../../../src/server/admin-moderation-db";
import { staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Every listing for moderation: ?q (title, address, suburb, postcode or id) &status &jurisdiction &transactionType &cursor. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "listing.moderate");
  if (staff instanceof NextResponse) return staff;
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k)?.trim().slice(0, 120) || undefined;
  const q = get("q"), status = get("status"), jurisdiction = get("jurisdiction"), transactionType = get("transactionType"), cursor = get("cursor");
  const page = await searchListings(getDb(), {
    ...(q ? { q } : {}), ...(status ? { status } : {}), ...(jurisdiction ? { jurisdiction } : {}),
    ...(transactionType ? { transactionType } : {}), ...(cursor ? { cursor } : {})
  });
  return NextResponse.json(
    { listings: page.rows.map(r => ({ ...r, actions: listingActionsFor(r.status) })), nextCursor: page.nextCursor, canBulk: staffCan(staff, "listing.bulk") },
    { headers: { "cache-control": "no-store" } }
  );
}

export const GET = withApi(handleGet);
