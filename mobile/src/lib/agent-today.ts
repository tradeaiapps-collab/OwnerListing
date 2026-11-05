/** What needs an agent's attention today. Pure: the dashboard passes in what it loaded. */
export interface SettlementLite { id: string; listingTitle: string; currentStage: string; completed: boolean; fellThrough: boolean; stuck: { stuck: boolean; days: number; blocked: boolean }; nextTarget: string | null }
export interface BookingLite { id: string; title: string; startsAt: string; endsAt: string; status: string; buyerName: string }
export interface OfferLite { id: string; status: string }

export type Pending =
  | { kind: "offer"; key: string; listingId: string; title: string; detail: string; at?: string }
  | { kind: "settlement"; key: string; settlementId: string; title: string; detail: string; at?: string }
  | { kind: "inspection"; key: string; title: string; detail: string; at: string };

const AWAITING = new Set(["submitted", "under_review", "buyer_countered"]);
export const awaitingDecision = (offers: readonly OfferLite[]) => offers.filter(o => AWAITING.has(o.status)).length;

/**
 * Most urgent first: offers waiting for a decision, stuck or blocked settlements (longest first), settlements with a target date
 * in the next 3 days, then inspections that have ended but are still "booked" (to be marked complete).
 */
export function pendingActions(i: {
  offers: readonly { listingId: string; title: string; offers: readonly OfferLite[] }[];
  settlements: readonly SettlementLite[];
  bookings: readonly BookingLite[];
  now: Date;
}): Pending[] {
  const out: Pending[] = [];
  for (const l of i.offers) {
    const n = awaitingDecision(l.offers);
    if (n > 0) out.push({ kind: "offer", key: `offer:${l.listingId}`, listingId: l.listingId, title: l.title, detail: n === 1 ? "1 offer waiting for a decision" : `${n} offers waiting for a decision` });
  }
  const open = i.settlements.filter(s => !s.completed && !s.fellThrough);
  for (const s of open.filter(x => x.stuck.stuck).sort((a, b) => b.stuck.days - a.stuck.days)) {
    out.push({ kind: "settlement", key: `settlement:${s.id}`, settlementId: s.id, title: s.listingTitle, detail: s.stuck.blocked ? `Blocked at ${s.currentStage}` : `Stuck at ${s.currentStage} for ${s.stuck.days} days` });
  }
  const soon = i.now.getTime() + 3 * 86_400_000;
  for (const s of open.filter(x => !x.stuck.stuck && x.nextTarget && Date.parse(`${x.nextTarget}T00:00:00Z`) <= soon)) {
    out.push({ kind: "settlement", key: `due:${s.id}`, settlementId: s.id, title: s.listingTitle, detail: `${s.currentStage} due ${s.nextTarget}`, at: s.nextTarget! });
  }
  for (const b of i.bookings.filter(x => x.status === "booked" && Date.parse(x.endsAt) < i.now.getTime()).sort((a, b) => a.endsAt.localeCompare(b.endsAt))) {
    out.push({ kind: "inspection", key: `inspection:${b.id}`, title: b.title, detail: `Inspection with ${b.buyerName} has finished. Mark it complete.`, at: b.endsAt });
  }
  return out;
}

/** "Mark complete" and "Send reminder" only make sense for a booked inspection; reminders only before it starts. */
export const inspectionActions = (b: BookingLite, now: Date): ("complete" | "remind" | "no_show")[] => {
  if (b.status !== "booked") return [];
  const started = Date.parse(b.startsAt) <= now.getTime();
  return started ? ["complete", "no_show"] : ["remind"];
};

/** Settlements grouped for the list: stuck first (already sorted by the server), with a one-line status. */
export const stageLine = (s: { currentStage: string; completed: boolean; fellThrough: boolean; stuck: { stuck: boolean; days: number; blocked: boolean } }): string =>
  s.fellThrough ? "Fell through" : s.completed ? "Settled" : s.stuck.blocked ? `Blocked · ${s.currentStage}` : s.stuck.stuck ? `Stuck ${s.stuck.days}d · ${s.currentStage}` : s.currentStage;
