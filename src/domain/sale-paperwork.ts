import { disclosureLabel } from "./listing-compliance";
import { checkOutbound, type Draft } from "./elena-jobs";
import { STAGE_LABEL, isStage, type ItemRole } from "./settlement";

/**
 * The sale paperwork checklist for one listing, and the rules for how Elena chases what is missing. Pure functions; the reads and the
 * reminder run are in src/server/sale-paperwork-db.ts.
 *
 * Nothing here is invented. Every item comes from a rule the platform already has:
 *   - disclosures: the keys compliance configured for this state and listing kind (listing_disclosure, disclosure config);
 *   - the publish gate: a verified trust account (src/domain/publish.ts);
 *   - the settlement tracker's own checklist for the accepted offer (src/domain/settlement.ts CHECKLIST_TEMPLATE);
 *   - the contract of sale and inspection reports, read from the signing documents and uploaded files, shown as "needed before settlement"
 *     (the tracker's exchange step) and "recommended" respectively.
 * Elena gives workflow help, not legal advice. What a state requires is for compliance and the people's solicitor or conveyancer to say.
 */
export const PAPERWORK_NOTE = "Elena gives workflow help, not legal advice. Ask your solicitor or conveyancer what your contract and state require.";

export type PaperParty = "owner" | "buyer" | "staff" | "agent";
/** upcoming: a step of a later settlement stage. It still has to be done, but nobody is chased for it yet. */
export type PaperStatus = "done" | "in_progress" | "open" | "upcoming";
/** publish: the existing publish gate. settlement: needed before the tracker can finish. none: recommended, never blocks. */
export type Blocks = "publish" | "settlement" | "none";
export type PaperGroup = "Disclosures" | "Deposit" | "Contract" | "Reports" | "Identity" | "Settlement steps";

export interface PaperItem {
  key: string; group: PaperGroup; label: string; party: PaperParty; status: PaperStatus; blocks: Blocks; detail?: string;
}

export interface PaperFacts {
  listingPublished: boolean;
  /** Keys compliance requires; null while not configured for this state and listing kind. */
  requiredDisclosures: readonly string[] | null;
  disclosures: readonly { key: string; satisfied: boolean }[];
  trustAccountApproved: boolean;
  /** Newest signing document's status, if any. */
  contractSigning?: "draft" | "out_for_signature" | "completed" | "declined" | "cancelled";
  contractFileUploaded: boolean;
  buildingReport: boolean;
  pestReport: boolean;
  /** The accepted offer's buyer and settlement, when a sale is in progress. */
  sale?: { settlementId: string; buyerIdVerified: boolean; items: readonly { stage: string; role: ItemRole; itemId: string; label: string; done: boolean; upcoming: boolean }[] };
}

const ROLE_PARTY: Record<ItemRole, PaperParty> = { buyer: "buyer", seller: "owner", agent: "agent", lawyer: "owner" };

export function buildChecklist(f: PaperFacts): PaperItem[] {
  const items: PaperItem[] = [];
  const gate: Blocks = f.listingPublished ? "settlement" : "publish";
  if (f.requiredDisclosures === null) {
    items.push({ key: "disclosures-config", group: "Disclosures", label: "Required disclosures for this state", party: "staff", status: "open", blocks: gate, detail: "Compliance has not set the required disclosures for this state and listing kind yet." });
  } else {
    const satisfied = new Set(f.disclosures.filter(d => d.satisfied).map(d => d.key));
    for (const key of f.requiredDisclosures) items.push({ key: `disclosure:${key}`, group: "Disclosures", label: disclosureLabel(key), party: "owner", status: satisfied.has(key) ? "done" : "open", blocks: gate });
  }
  items.push({ key: "trust-account", group: "Deposit", label: "Trust account verified", party: "owner", status: f.trustAccountApproved ? "done" : "open", blocks: gate, detail: "Deposits go to the solicitor's trust account. The platform holds no money." });

  const cs = f.contractSigning;
  const contractDone = cs === "completed" || f.contractFileUploaded;
  items.push({
    key: "contract-of-sale", group: "Contract", label: "Contract of sale", party: "owner", blocks: "settlement",
    status: contractDone ? "done" : cs === "draft" || cs === "out_for_signature" ? "in_progress" : "open",
    ...(contractDone ? {} : { detail: cs === "out_for_signature" ? "Out for signature." : cs === "draft" ? "A draft exists and has not been sent." : cs === "declined" ? "A signer declined. Ask your solicitor how to proceed." : "No contract uploaded or signed yet." })
  });
  items.push({ key: "building-report", group: "Reports", label: "Building inspection report", party: "owner", status: f.buildingReport ? "done" : "open", blocks: "none", detail: "Recommended: buyers commonly ask for it." });
  items.push({ key: "pest-report", group: "Reports", label: "Pest inspection report", party: "owner", status: f.pestReport ? "done" : "open", blocks: "none", detail: "Recommended: buyers commonly ask for it." });

  if (f.sale) {
    items.push({ key: "buyer-id", group: "Identity", label: "Buyer's identity check", party: "buyer", status: f.sale.buyerIdVerified ? "done" : "open", blocks: "none", detail: "Checked by the platform; the buyer sees only that it is outstanding." });
    for (const s of f.sale.items) {
      items.push({
        key: `settlement:${s.stage}:${s.role}:${s.itemId}`, group: "Settlement steps", label: `${s.label} (${isStage(s.stage) ? STAGE_LABEL[s.stage] : s.stage})`,
        party: ROLE_PARTY[s.role], status: s.done ? "done" : s.upcoming ? "upcoming" : "open", blocks: "settlement"
      });
    }
  }
  return items;
}

export interface PaperSummary { done: number; total: number; blockers: PaperItem[]; later: PaperItem[]; recommended: PaperItem[]; readyForSettlement: boolean; headline: string }

/** What is complete and what blocks. Only a sale in progress can be "ready": before that the headline says what is left to list. */
export function summarise(items: readonly PaperItem[], saleInProgress: boolean): PaperSummary {
  const open = items.filter(i => i.status !== "done");
  const blockers = open.filter(i => i.blocks !== "none" && i.status !== "upcoming");
  const later = open.filter(i => i.blocks !== "none" && i.status === "upcoming");
  const recommended = open.filter(i => i.blocks === "none");
  const done = items.length - open.length;
  const ready = saleInProgress && blockers.length === 0 && later.length === 0;
  const headline = blockers.length > 0
    ? `${blockers.length} ${blockers.length === 1 ? "item blocks" : "items block"} ${saleInProgress ? "settlement" : "the sale"}.`
    : later.length > 0 ? `Nothing is blocking you now. ${later.length} later ${later.length === 1 ? "step" : "steps"} still to come.`
    : saleInProgress ? "Nothing is blocking settlement." : "Nothing is blocking the listing.";
  return { done, total: items.length, blockers, later, recommended, readyForSettlement: ready, headline };
}

// ---- Chasing -----------------------------------------------------------------------------------------------------------------------

export const CHASE = {
  /** First reminder after switching on (or after the sale starts), then this long between reminders. */
  firstAfterMs: 24 * 3600_000,
  gapMs: 3 * 24 * 3600_000,
  /** After this many reminders to one person Elena stops and says so; the owner follows up. */
  maxReminders: 3,
  /** Hard cap on messages to one person about one listing in a rolling 24 hours. */
  maxPerPartyPerDay: 1,
  maxItemsListed: 6
} as const;

export type ChaseParty = "owner" | "buyer";

/** The items Elena may chase for a person: only blocking ones on their side, and only while a sale is in progress. */
export function chaseItems(items: readonly PaperItem[], party: ChaseParty, saleInProgress: boolean): PaperItem[] {
  if (!saleInProgress) return [];
  return items.filter(i => i.party === party && (i.status === "open" || i.status === "in_progress") && i.blocks !== "none");
}

export type ChaseState = "active" | "done" | "stopped";
export interface ChaseRow { state: ChaseState; reminders: number; nextActionAt: string }
export type ChaseStep =
  | { kind: "wait" }
  | { kind: "send"; reminderNo: number }
  | { kind: "done" }
  | { kind: "stop" };

/**
 * What to do for one person at `now`. Done as soon as nothing of theirs is open (a stopped run restarts only if a new item appears after
 * it ended). After maxReminders unanswered reminders it stops instead of sending another. Never sends before the next time is due.
 */
export function nextChaseStep(row: ChaseRow | undefined, openCount: number, now: string): ChaseStep {
  if (openCount === 0) return row && row.state === "active" ? { kind: "done" } : { kind: "wait" };
  if (!row || row.state !== "active") return { kind: "wait" };
  if (Date.parse(now) < Date.parse(row.nextActionAt)) return { kind: "wait" };
  return row.reminders >= CHASE.maxReminders ? { kind: "stop" } : { kind: "send", reminderNo: row.reminders + 1 };
}

export interface ReminderVars { to: string; address: string; labels: readonly string[]; reminderNo: number; party: ChaseParty }
const first = (n: string) => n.trim().split(/\s+/)[0] || "there";

/** Fixed wording. The link is passed to the sender separately; nothing in the text is a contact detail or an amount. */
export function draftReminder(v: ReminderVars): Draft {
  const shown = v.labels.slice(0, CHASE.maxItemsListed);
  const more = v.labels.length - shown.length;
  const lines = shown.map(l => `• ${l}`).join("\n");
  const where = v.party === "owner" ? "on your side" : "for you";
  return {
    title: v.reminderNo > 1 ? "Reminder: sale paperwork still open" : "Sale paperwork: a few items to finish",
    body: `Hi ${first(v.to)}, Elena here. For ${v.address}, these items are still open ${where}:\n${lines}${more > 0 ? `\n…and ${more} more.` : ""}\n\nYou can tick them off or see what is left in your checklist. ${PAPERWORK_NOTE} Replies to this message are not read.`
  };
}

export const checkReminder = (d: Draft) => checkOutbound(d);

export function stoppedNote(address: string, party: ChaseParty): Draft {
  return {
    title: "Elena has stopped chasing paperwork",
    body: `For ${address}, Elena sent ${CHASE.maxReminders} reminders to the ${party === "buyer" ? "buyer" : "owner"} and has now stopped. Some items are still open, so you may want to follow up yourself.`
  };
}
