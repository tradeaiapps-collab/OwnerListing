import { describe, expect, it } from "vitest";
import {
  addBusinessDays, CHECKLIST_TEMPLATE, mayTick, mayUpdateMilestones, milestoneBlocker, newChecklists, parseAction, STAGES, stuckInfo, STUCK_DAYS, type MilestoneChange
} from "../src/domain/settlement";

describe("settlement domain", () => {
  it("has eight stages and a checklist for every one", () => {
    expect(STAGES).toHaveLength(8);
    for (const s of STAGES) expect(Object.keys(CHECKLIST_TEMPLATE[s]).length).toBeGreaterThan(0);
    const all = newChecklists();
    expect(all.every(c => c.items.every(i => !i.done && i.doneAt === null))).toBe(true);
    expect(new Set(all.flatMap(c => c.items.map(i => `${c.stage}/${i.id}`))).size).toBe(all.reduce((n, c) => n + c.items.length, 0));
  });

  it("lets each side tick its own items; owner and agent also tick for the solicitors; the buyer does not", () => {
    expect(mayTick("buyer", "buyer")).toBe(true);
    expect(mayTick("buyer", "seller")).toBe(false);
    expect(mayTick("buyer", "lawyer")).toBe(false);
    expect(mayTick("seller", "lawyer")).toBe(true);
    expect(mayTick("agent", "lawyer")).toBe(true);
    expect(mayTick("agent", "seller")).toBe(false);
    expect(mayUpdateMilestones("buyer")).toBe(false);
    expect(mayUpdateMilestones("agent")).toBe(true);
  });

  it("counts business days past weekends and holidays", () => {
    expect(addBusinessDays("2026-11-05", 5)).toBe("2026-11-12");
    expect(addBusinessDays("2026-11-05", 5, ["2026-11-10"])).toBe("2026-11-13");
    expect(addBusinessDays("2026-11-06", 1)).toBe("2026-11-09");
  });

  it("flags a stage as stuck after more than five days, or when blocked, but never when finished", () => {
    const now = new Date("2026-11-10T12:00:00Z"), at = (d: string) => new Date(`${d}T12:00:00Z`);
    expect(STUCK_DAYS).toBe(5);
    expect(stuckInfo({ completed: false, currentStatus: "pending", enteredAt: at("2026-11-05"), now })).toEqual({ stuck: false, days: 5, blocked: false });
    expect(stuckInfo({ completed: false, currentStatus: "pending", enteredAt: at("2026-11-04"), now }).stuck).toBe(true);
    expect(stuckInfo({ completed: false, currentStatus: "blocked", enteredAt: at("2026-11-10"), now })).toEqual({ stuck: true, days: 0, blocked: true });
    expect(stuckInfo({ completed: true, currentStatus: "completed", enteredAt: at("2026-01-01"), now }).stuck).toBe(false);
  });

  it("parses actions strictly", () => {
    expect(parseAction(null).ok).toBe(false);
    expect(parseAction({ action: "milestone", stage: "nope", status: "completed" }).ok).toBe(false);
    expect(parseAction({ action: "milestone", stage: "finance_approval", status: "blocked" }).ok).toBe(false);
    expect(parseAction({ action: "milestone", stage: "finance_approval", status: "blocked", note: "Waiting on the bank" }).ok).toBe(true);
    expect(parseAction({ action: "milestone", stage: "finance_approval", targetDate: "2026-02-30" }).ok).toBe(false);
    expect(parseAction({ action: "milestone", stage: "finance_approval" }).ok).toBe(false);
    expect(parseAction({ action: "milestone", stage: "finance_approval", actualDate: "2026-11-05" }).ok).toBe(false);
    expect(parseAction({ action: "tick", stage: "offer_accepted", role: "buyer", itemId: "buyer-0", done: true }).ok).toBe(true);
    expect(parseAction({ action: "tick", stage: "offer_accepted", role: "buyer", itemId: "x; drop", done: true }).ok).toBe(false);
    expect(parseAction({ action: "tick", stage: "offer_accepted", role: "buyer", itemId: "buyer-0", done: "yes" }).ok).toBe(false);
  });

  it("only lets the owner or agent complete the open stage, never reopen, never in the future", () => {
    const ms = STAGES.map((stage, i) => ({ stage, status: i === 0 ? "completed" as const : "pending" as const, actualDate: i === 0 ? "2026-11-03" : null }));
    const base = { side: "seller" as const, current: "deposit_received" as const, milestones: ms, today: "2026-11-05", offerStatus: "accepted" };
    const done = (c: Partial<MilestoneChange> = {}): MilestoneChange => ({ stage: "deposit_received", status: "completed", ...c });
    expect(milestoneBlocker({ ...base, change: done() })).toBeNull();
    expect(milestoneBlocker({ ...base, side: "buyer", change: done() })).toMatch(/owner or their agent/);
    expect(milestoneBlocker({ ...base, change: done({ stage: "finance_approval" }) })).toMatch(/stage the sale is at/);
    expect(milestoneBlocker({ ...base, change: { stage: "offer_accepted", status: "blocked", note: "x" } })).toMatch(/already completed/);
    expect(milestoneBlocker({ ...base, change: done({ actualDate: "2026-11-06" }) })).toMatch(/future/);
    expect(milestoneBlocker({ ...base, change: done({ actualDate: "2026-11-02" }) })).toMatch(/before the previous/);
    expect(milestoneBlocker({ ...base, offerStatus: "fallen_through", change: done() })).toMatch(/fallen through/);
    expect(milestoneBlocker({ ...base, change: { stage: "finance_approval", targetDate: "2026-12-01" } })).toBeNull();
  });
});
