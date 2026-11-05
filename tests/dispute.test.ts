import { describe, expect, it } from "vitest";
import {
  assessRisk, deadlineFor, ESCALATE_AFTER_DAYS, evaluateRound, isOverdue, MAX_ROUNDS, mediate, parseAction, parseCreate, type MediationInput
} from "../src/domain/dispute";

const base: MediationInput = {
  type: "repair", round: 1, claimCents: 10_000_00, buyerSharePct: 100, sellerSharePct: 20, buyerText: "Roof leaks, seller pays", sellerText: "Buyer knew", description: "Roof repair after the inspection",
  daysOpen: 0, daysToSettlement: 40, settlementBlocked: false, history: null
};

describe("dispute input", () => {
  const ok = { type: "inspection", title: "Roof", description: "Leak found", position: "Seller repairs", claimCents: 450000, sellerSharePct: 100 };
  it("accepts a complete dispute and trims text", () => {
    const r = parseCreate({ ...ok, title: "  Roof  " });
    expect(r).toMatchObject({ ok: true, value: { title: "Roof", claimCents: 450000, sellerSharePct: 100 } });
  });
  it("needs a type, text and a consistent amount and share", () => {
    expect(parseCreate(null).ok).toBe(false);
    expect(parseCreate({ ...ok, type: "other" }).ok).toBe(false);
    expect(parseCreate({ ...ok, title: " " }).ok).toBe(false);
    expect(parseCreate({ ...ok, description: "x".repeat(2001) }).ok).toBe(false);
    expect(parseCreate({ ...ok, claimCents: 1.5 }).ok).toBe(false);
    expect(parseCreate({ ...ok, claimCents: -5 }).ok).toBe(false);
    expect(parseCreate({ ...ok, sellerSharePct: 101 }).ok).toBe(false);
    expect(parseCreate({ ...ok, claimCents: undefined }).ok).toBe(false);
    expect(parseCreate({ ...ok, sellerSharePct: undefined }).ok).toBe(false);
    expect(parseCreate({ ...ok, claimCents: undefined, sellerSharePct: undefined, type: "cooling_off" }).ok).toBe(true);
  });
  it("parses actions against whether the dispute has an amount", () => {
    expect(parseAction({ action: "withdraw" }, true)).toEqual({ ok: true, value: { action: "withdraw" } });
    expect(parseAction({ action: "position", position: "Fix it", sellerSharePct: 30 }, true)).toMatchObject({ ok: true, value: { sellerSharePct: 30 } });
    expect(parseAction({ action: "position", position: "Fix it" }, true).ok).toBe(false);
    expect(parseAction({ action: "position", position: "Fix it", sellerSharePct: 30 }, false)).toMatchObject({ ok: true, value: { sellerSharePct: null } });
    expect(parseAction({ action: "respond", response: "accept" }, true)).toMatchObject({ ok: true, value: { response: "accept", sellerSharePct: null } });
    expect(parseAction({ action: "respond", response: "counter" }, true).ok).toBe(false);
    expect(parseAction({ action: "respond", response: "counter", sellerSharePct: 40 }, true)).toMatchObject({ ok: true, value: { sellerSharePct: 40 } });
    expect(parseAction({ action: "respond", response: "counter" }, false).ok).toBe(false);
    expect(parseAction({ action: "respond", response: "counter", note: "Two weeks more" }, false)).toMatchObject({ ok: true });
    expect(parseAction({ action: "respond", response: "maybe" }, true).ok).toBe(false);
    expect(parseAction({ action: "nope" }, true).ok).toBe(false);
  });
});

describe("rounds and escalation", () => {
  it("settles on two accepts, escalates on a request, otherwise runs to three rounds", () => {
    expect(evaluateRound(1, "accept", null)).toEqual({ kind: "wait" });
    expect(evaluateRound(1, "accept", "accept")).toEqual({ kind: "agreed" });
    expect(evaluateRound(1, "counter", "accept")).toEqual({ kind: "next_round" });
    expect(evaluateRound(2, "counter", "counter")).toEqual({ kind: "next_round" });
    expect(evaluateRound(MAX_ROUNDS, "counter", "accept")).toEqual({ kind: "escalate", reason: "max_rounds" });
    expect(evaluateRound(1, "escalate", null)).toEqual({ kind: "escalate", reason: "requested" });
    expect(evaluateRound(1, "accept", "escalate")).toEqual({ kind: "escalate", reason: "requested" });
    expect(evaluateRound(MAX_ROUNDS, "accept", "accept")).toEqual({ kind: "agreed" });
  });
  it("times out after five days, not before", () => {
    const created = new Date("2026-11-01T00:00:00Z"), deadline = deadlineFor(created);
    expect(ESCALATE_AFTER_DAYS).toBe(5);
    expect(deadline.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(isOverdue(deadline, new Date("2026-11-05T23:59:59Z"))).toBe(false);
    expect(isOverdue(deadline, new Date("2026-11-06T00:00:00Z"))).toBe(true);
  });
});

describe("Elena's mediation", () => {
  it("is the same every time and splits the middle of the two positions", () => {
    const a = mediate(base), b = mediate(base);
    expect(a).toEqual(b);
    expect(a.sellerSharePct).toBe(60);
    expect(a.buyerSharePct).toBe(40);
    expect(a.sellerPaysCents).toBe(6_000_00);
    expect(a.buyerPaysCents).toBe(4_000_00);
    expect(a.sellerPaysCents! + a.buyerPaysCents!).toBe(base.claimCents);
    expect(a.headline).toBe("Buyer covers 40%, seller covers 60% of the cost.");
    expect(a.disclaimer).toMatch(/not legal advice/);
  });
  it("leans on similar past disputes only with enough of them", () => {
    expect(mediate({ ...base, history: { samples: 2, medianSellerSharePct: 80 } }).sellerSharePct).toBe(60);
    const s = mediate({ ...base, history: { samples: 10, medianSellerSharePct: 80 } });
    expect(s.sellerSharePct).toBe(70);
    expect(s.history).toEqual({ samples: 10, medianSellerSharePct: 80 });
    expect(s.reasoning.join(" ")).toMatch(/10 cases/);
  });
  it("ignores history after round 1 and works from the latest stances", () => {
    expect(mediate({ ...base, round: 2, buyerSharePct: 70, sellerSharePct: 50, history: { samples: 10, medianSellerSharePct: 0 } }).sellerSharePct).toBe(60);
  });
  it("suggests terms and dates when no amount is in dispute", () => {
    const s = mediate({ ...base, type: "cooling_off", claimCents: null, buyerSharePct: null, sellerSharePct: null });
    expect(s.sellerSharePct).toBeNull();
    expect(s.sellerPaysCents).toBeNull();
    expect(s.templates.some(t => /solicitors/.test(t.text))).toBe(true);
  });
  it("offers wording for every type, including asking for more time", () => {
    for (const type of ["inspection", "financing", "repair", "cooling_off"] as const) expect(mediate({ ...base, type }).templates.at(-1)!.label).toBe("Accept but ask for more time");
  });
  it("rates the risk and warns of a fall-through when it piles up", () => {
    expect(assessRisk({ ...base, buyerSharePct: 40, sellerSharePct: 30, sellerText: "", buyerText: "", description: "paint", daysToSettlement: 40 }).level).toBe("low");
    const high = assessRisk({ ...base, type: "financing", round: 3, daysToSettlement: 5, daysOpen: 4, settlementBlocked: true });
    expect(high.level).toBe("high");
    expect(high.likelyFallThrough).toBe(true);
    expect(high.reasons.length).toBeGreaterThan(3);
    expect(assessRisk({ ...base, round: 2, buyerSharePct: 70, sellerSharePct: 40, description: "paint", buyerText: "", sellerText: "" }).level).toBe("medium");
  });
  it("flags serious defects named in the texts", () => {
    expect(assessRisk({ ...base, description: "Termite damage found" }).reasons.join(" ")).toMatch(/serious defect/);
  });
});
