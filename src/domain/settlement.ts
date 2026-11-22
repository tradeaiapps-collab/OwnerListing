import type { Result } from "./deposit-escrow";

/**
 * Settlement tracker: the eight stages from an accepted offer to settlement, a simple checklist per stage and role, and the rules for who may
 * change what. Pure functions; src/server/settlement-db.ts does the storing. Dates are estimates the people involved enter, not legal advice.
 */
export const STAGES = ["offer_accepted", "deposit_received", "cooling_off_expires", "inspection_completed", "finance_approval", "lawyer_exchange", "settlement_scheduled", "settlement_completed"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  offer_accepted: "Offer accepted", deposit_received: "Deposit received", cooling_off_expires: "Cooling-off expires", inspection_completed: "Inspection completed",
  finance_approval: "Finance approval", lawyer_exchange: "Lawyer exchange", settlement_scheduled: "Settlement scheduled", settlement_completed: "Settlement completed"
};
export const isStage = (v: unknown): v is Stage => typeof v === "string" && (STAGES as readonly string[]).includes(v);

export type MilestoneStatus = "pending" | "completed" | "blocked";
/** The person's side of the sale. "lawyer" only labels checklist items: solicitors have no accounts here, so the owner or agent ticks for them. */
export type Side = "buyer" | "seller" | "agent";
export type ItemRole = Side | "lawyer";

/** A stage that has sat open longer than this many days is flagged as stuck. */
export const STUCK_DAYS = 5;
export const MAX_NOTE = 500;

export interface ChecklistItem { id: string; label: string; done: boolean; doneAt: string | null; doneByRole: Side | null }

/** The starting checklist for each stage, by role. */
export const CHECKLIST_TEMPLATE: Record<Stage, Partial<Record<ItemRole, string[]>>> = {
  offer_accepted: { buyer: ["Confirm finance needs"], seller: ["Confirm settlement timeframe"], agent: ["Confirm availability"] },
  deposit_received: { buyer: ["Arrange the deposit"], agent: ["Collect the deposit", "Document the deposit confirmation"] },
  cooling_off_expires: { buyer: ["Complete the inspection"], agent: ["Confirm the buyer is still interested"] },
  inspection_completed: { buyer: ["Share the inspection report"], seller: ["Give access for the inspection"] },
  finance_approval: { buyer: ["Get pre-approval or upload the approval letter"], agent: ["Share the approval with the seller"] },
  lawyer_exchange: { lawyer: ["Solicitors confirm contracts are ready", "Buyer's solicitor signs off", "Seller's solicitor signs off"] },
  settlement_scheduled: { agent: ["Confirm the settlement date with both solicitors"], buyer: ["Confirm the settlement date"], seller: ["Confirm the settlement date"] },
  settlement_completed: { buyer: ["Final walkthrough"], lawyer: ["Funds transferred"], agent: ["Keys exchanged"] }
};

const ROLE_ORDER: ItemRole[] = ["buyer", "seller", "agent", "lawyer"];
export function newChecklists(): { stage: Stage; role: ItemRole; items: ChecklistItem[] }[] {
  const out: { stage: Stage; role: ItemRole; items: ChecklistItem[] }[] = [];
  for (const stage of STAGES) for (const role of ROLE_ORDER) {
    const labels = CHECKLIST_TEMPLATE[stage][role];
    if (labels) out.push({ stage, role, items: labels.map((label, i) => ({ id: `${role}-${i}`, label, done: false, doneAt: null, doneByRole: null })) });
  }
  return out;
}

/** Whose items this side may tick: their own, and the solicitors' (the owner and agent act for them). */
export const mayTick = (side: Side, itemRole: ItemRole): boolean => itemRole === side || (itemRole === "lawyer" && side !== "buyer");
/** The buyer follows the sale; the owner and the appointed agent move it along. */
export const mayUpdateMilestones = (side: Side): boolean => side !== "buyer";

// ---------- dates ----------
const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(ms(v)) && iso(ms(v)) === v;

/** The date `n` business days after `from` (Monday to Friday, skipping the given holidays). */
export function addBusinessDays(from: string, n: number, holidays: Iterable<string> = []): string {
  const off = new Set(holidays);
  let t = ms(from), left = n;
  while (left > 0) {
    t += DAY;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6 && !off.has(iso(t))) left--;
  }
  return iso(t);
}
/** 2026-11-05 as "5 Nov 2026". */
export const dateLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
export const addDays = (from: string, n: number): string => iso(ms(from) + n * DAY);

// ---------- progress and bottlenecks ----------
export interface MilestoneLike { stage: Stage; status: MilestoneStatus }
export const nextStage = (s: Stage): Stage | null => STAGES[STAGES.indexOf(s) + 1] ?? null;
export const progress = (ms: readonly MilestoneLike[]) => ({ done: ms.filter(m => m.status === "completed").length, total: STAGES.length });

export interface Stuck { stuck: boolean; days: number; blocked: boolean }
/** An open stage is stuck when it is blocked, or has been open for more than STUCK_DAYS whole days. A finished settlement is never stuck. */
export function stuckInfo(i: { completed: boolean; currentStatus: MilestoneStatus; enteredAt: Date; now: Date }): Stuck {
  if (i.completed) return { stuck: false, days: 0, blocked: false };
  const days = Math.max(0, Math.floor((i.now.getTime() - i.enteredAt.getTime()) / DAY));
  const blocked = i.currentStatus === "blocked";
  return { stuck: blocked || days > STUCK_DAYS, days, blocked };
}

// ---------- changes ----------
export interface MilestoneChange { stage: Stage; status?: MilestoneStatus; targetDate?: string | null; actualDate?: string; note?: string | null }
export interface TickChange { stage: Stage; role: ItemRole; itemId: string; done: boolean }
export type SettlementAction = ({ action: "milestone" } & MilestoneChange) | ({ action: "tick" } & TickChange);

export function parseAction(body: Record<string, unknown> | null): Result<SettlementAction> {
  const bad = (error: string): Result<never> => ({ ok: false, error });
  if (!body) return bad("Send a JSON body.");
  if (!isStage(body["stage"])) return bad("Choose a stage.");
  const stage = body["stage"];
  if (body["action"] === "tick") {
    const role = body["role"], itemId = body["itemId"];
    if (role !== "buyer" && role !== "seller" && role !== "agent" && role !== "lawyer") return bad("Choose a checklist role.");
    if (typeof itemId !== "string" || !/^[a-z]+-\d{1,2}$/.test(itemId)) return bad("Choose a checklist item.");
    if (typeof body["done"] !== "boolean") return bad("Say whether the item is done.");
    return { ok: true, value: { action: "tick", stage, role, itemId, done: body["done"] } };
  }
  if (body["action"] !== "milestone") return bad("Unknown action.");
  const v: MilestoneChange = { stage };
  if (body["status"] !== undefined) {
    if (body["status"] !== "pending" && body["status"] !== "completed" && body["status"] !== "blocked") return bad("Status must be pending, completed or blocked.");
    v.status = body["status"];
  }
  if (body["targetDate"] !== undefined) {
    if (body["targetDate"] !== null && !isDay(body["targetDate"])) return bad("Target date must be a real date (YYYY-MM-DD).");
    v.targetDate = body["targetDate"] as string | null;
  }
  if (body["actualDate"] !== undefined) {
    if (!isDay(body["actualDate"])) return bad("Completion date must be a real date (YYYY-MM-DD).");
    v.actualDate = body["actualDate"];
  }
  if (body["note"] !== undefined) {
    if (body["note"] !== null && (typeof body["note"] !== "string" || body["note"].trim().length > MAX_NOTE)) return bad(`Keep the note under ${MAX_NOTE} characters.`);
    v.note = typeof body["note"] === "string" && body["note"].trim() ? body["note"].trim() : null;
  }
  if (v.status === undefined && v.targetDate === undefined && v.note === undefined) return bad("Nothing to change.");
  if (v.status === "blocked" && !v.note) return bad("Say what is blocking this stage.");
  if (v.actualDate !== undefined && v.status !== "completed") return bad("A completion date only goes with completing the stage.");
  return { ok: true, value: { action: "milestone", ...v } };
}

export interface PlanInput {
  side: Side; current: Stage; milestones: readonly (MilestoneLike & { actualDate: string | null })[]; change: MilestoneChange; today: string; offerStatus: string;
}
/** Why a milestone change is refused, or null. Only the open stage can be completed or blocked; a finished stage never reopens. */
export function milestoneBlocker(i: PlanInput): string | null {
  if (!mayUpdateMilestones(i.side)) return "Only the owner or their agent can update the timeline.";
  if (i.offerStatus === "fallen_through") return "This sale has fallen through, so its timeline is closed.";
  const m = i.milestones.find(x => x.stage === i.change.stage);
  if (!m) return "Stage not found.";
  if (m.status === "completed") return "This stage is already completed.";
  if (i.change.status !== undefined && i.change.stage !== i.current) return "Only the stage the sale is at can be completed or blocked.";
  if (i.change.status === "completed" && i.change.actualDate !== undefined) {
    if (i.change.actualDate > i.today) return "The completion date cannot be in the future.";
    const prev = [...i.milestones].reverse().find(x => STAGES.indexOf(x.stage) < STAGES.indexOf(i.change.stage) && x.actualDate);
    if (prev?.actualDate && i.change.actualDate < prev.actualDate) return "The completion date cannot be before the previous stage was completed.";
  }
  return null;
}
