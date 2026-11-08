import type { Queryable } from "./db";

/** The public number of a listing, e.g. 10234. Shown as #10234. Constant SQL; the id is a bound parameter. */
export async function listingNumberPg(db: Queryable, listingId: string): Promise<number | undefined> {
  const r = await db.query("SELECT listing_number FROM property_listing WHERE id = $1::uuid", [listingId]);
  const n = r.rows[0]?.["listing_number"];
  return n === undefined || n === null ? undefined : Number(n);
}
