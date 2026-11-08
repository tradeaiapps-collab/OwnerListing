import { REASON_LABEL, type FallThroughReason, type Party } from "../domain/sale-fall-through";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
type What =
  | { kind: "proposed"; to: Party; reason: FallThroughReason }
  | { kind: "update"; to: Party; title: string; text: string }
  | { kind: "fallen_through"; to: Party[] };

/** Tells the buyer and/or owner of an offer about a sale-fell-through step. Ids and the address are looked up here, never taken from the request. Never throws. */
export async function notifyFallThrough(db: Queryable, offerId: string, what: What, env: Env = process.env): Promise<void> {
  try {
    const x = (await db.query(
      "SELECT o.buyer_user_id, o.listing_id, l.owner_user_id, l.address_text FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid", [offerId])).rows[0];
    if (!x) return;
    const listing = String(x["address_text"] ?? "");
    const link = (p: Party) => (p === "buyer" ? `/offers/${offerId}` : `/listings/${String(x["listing_id"])}/offers/${offerId}`);
    const id = (p: Party) => String(x[p === "buyer" ? "buyer_user_id" : "owner_user_id"]);
    const targets = what.kind === "fallen_through" ? what.to : [what.to];
    for (const p of targets) {
      if (what.kind === "proposed") await notifyUser(db, id(p), "fall_through_proposed", { listing, reason: REASON_LABEL[what.reason], link: link(p) }, env);
      else if (what.kind === "update") await notifyUser(db, id(p), "fall_through_update", { listing, title: what.title, text: what.text, link: link(p) }, env);
      else await notifyUser(db, id(p), "offer_fallen_through", { listing, link: link(p) }, env);
    }
  } catch {
    // A notification never blocks the step that caused it.
  }
}
