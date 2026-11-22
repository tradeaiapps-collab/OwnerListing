import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
type Party = "buyer" | "owner";
type Payout = "release" | "refund";
export type DepositNotice =
  | { kind: "held"; amountCents: number; dueDate: string | null }
  | { kind: "payout_pending"; payout: Payout; amountCents: number }
  | { kind: "paid"; payout: Payout; amountCents: number }
  | { kind: "split"; refundCents: number; releaseCents: number }
  | { kind: "resolved"; refundCents: number; releaseCents: number };
export type DepositRef = { offerId: string } | { holdingId: string };

export const aud = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const splitText = (refund: number, release: number) =>
  [refund > 0 ? `${aud(refund)} back to the buyer` : "", release > 0 ? `${aud(release)} to the seller` : ""].filter(Boolean).join(" and ") || "no payment";

const BY_OFFER = "SELECT o.id AS offer_id, o.buyer_user_id, o.listing_id, l.owner_user_id, l.address_text, (SELECT h.reference FROM deposit_holding h WHERE h.offer_id = o.id) AS reference FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid";
const BY_HOLDING = "SELECT o.id AS offer_id, o.buyer_user_id, o.listing_id, l.owner_user_id, l.address_text, h.reference FROM deposit_holding h JOIN formal_offer o ON o.id = h.offer_id JOIN property_listing l ON l.id = o.listing_id WHERE h.id = $1::uuid";

/**
 * Emails (and notifies in-app) the buyer and the owner about a deposit step, on each person's own offer-notification settings.
 * Names, addresses and ids are looked up here, never taken from a request. Amounts are what staff or the case recorded. Never throws:
 * a notification must not block the deposit step that caused it. Zero-amount payouts send nothing.
 */
export async function notifyDeposit(db: Queryable, ref: DepositRef, what: DepositNotice, env: Env = process.env): Promise<void> {
  try {
    if ((what.kind === "paid" || what.kind === "payout_pending") && !(what.amountCents > 0)) return;
    const x = (await db.query("offerId" in ref ? BY_OFFER : BY_HOLDING, ["offerId" in ref ? ref.offerId : ref.holdingId])).rows[0];
    if (!x) return;
    const offerId = String(x["offer_id"]);
    const base = { listing: String(x["address_text"] ?? ""), reference: String(x["reference"] ?? "") };
    const to: Record<Party, { id: string; link: string }> = {
      buyer: { id: String(x["buyer_user_id"]), link: `/offers/${offerId}` },
      owner: { id: String(x["owner_user_id"]), link: `/listings/${String(x["listing_id"])}/offers/${offerId}` }
    };
    for (const party of ["buyer", "owner"] as const) {
      const p = { ...base, party, link: to[party].link };
      const send = (kind: Parameters<typeof notifyUser>[2], extra: Record<string, string>) => notifyUser(db, to[party].id, kind, { ...p, ...extra }, env);
      switch (what.kind) {
        case "held": await send("deposit_held", { amount: aud(what.amountCents), due: what.dueDate ?? "" }); break;
        case "payout_pending": await send("deposit_payout_pending", { amount: aud(what.amountCents), payout: what.payout }); break;
        case "paid": await send(what.payout === "refund" ? "deposit_refunded" : "deposit_released", { amount: aud(what.amountCents) }); break;
        case "split": await send("deposit_split", { text: splitText(what.refundCents, what.releaseCents) }); break;
        case "resolved": await send("deposit_dispute_resolved", { text: splitText(what.refundCents, what.releaseCents) }); break;
      }
    }
  } catch {
    // A notification never blocks the deposit step.
  }
}
