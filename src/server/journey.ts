import { buyerChecklist, ownerChecklist, type JourneyStep } from "../domain/journey";
import type { Actor } from "../domain/listing-service";
import type { Queryable } from "./db";
import { hasCurrentTermsPg } from "./terms-db";

/**
 * Journey facts for the signed-in user, read from their OWN rows only (every query is keyed by actor.userId). Returns counts and
 * yes/no facts, never record contents, so it exposes nothing the user's existing pages do not already show them.
 */
export async function loadJourney(db: Queryable, actor: Actor, nowIso: string = new Date().toISOString()): Promise<{ role: "owner" | "buyer"; steps: JourneyStep[] } | null> {
  const termsAccepted = await hasCurrentTermsPg(db, actor.userId, nowIso);
  if (actor.userType === "buyer") {
    const v = (await db.query(
      `SELECT email_verified_at IS NOT NULL AS email, phone_verified_at IS NOT NULL AS phone, id_verified_at IS NOT NULL AS id
         FROM buyer_verification WHERE user_id = $1`, [actor.userId])).rows[0];
    const c = (await db.query(
      `SELECT (SELECT count(*)::int FROM saved_search WHERE buyer_user_id = $1 AND active) AS searches,
              (SELECT count(*)::int FROM enquiry WHERE buyer_user_id = $1) AS enquiries`, [actor.userId])).rows[0];
    return {
      role: "buyer",
      steps: buyerChecklist({
        emailVerified: v?.["email"] === true, phoneVerified: v?.["phone"] === true, idVerified: v?.["id"] === true,
        termsAccepted, savedSearches: Number(c?.["searches"] ?? 0), enquiries: Number(c?.["enquiries"] ?? 0)
      })
    };
  }
  if (actor.userType !== "owner" && actor.userType !== "agent") return null;
  const listings = (await db.query(
    `SELECT id, status FROM property_listing WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 200`, [actor.userId])).rows;
  const focus = listings.find(l => l["status"] !== "published" && l["status"] !== "withdrawn") ?? listings[0];
  const focusId = focus ? String(focus["id"]) : null;
  const f = (await db.query(
    `SELECT (SELECT count(*)::int FROM property_document d
              WHERE d.listing_id = $2 AND d.kind IN ('photo','photo_360') AND d.status = 'active') AS photos,
            EXISTS (SELECT 1 FROM invoice i JOIN property_listing l ON l.id = i.listing_id
              WHERE l.owner_user_id = $1 AND i.status IN ('pending','paid')) AS plan`, [actor.userId, focusId])).rows[0];
  return {
    role: "owner",
    steps: ownerChecklist({
      termsAccepted, listingCount: listings.length, focusListingId: focusId,
      photoCount: Number(f?.["photos"] ?? 0), planChosen: f?.["plan"] === true,
      published: listings.some(l => l["status"] === "published")
    })
  };
}
