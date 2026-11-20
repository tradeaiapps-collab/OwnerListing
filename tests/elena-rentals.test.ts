import { describe, expect, it } from "vitest";
import {
  MISSING_PROMPT, NOT_USED_NOTE, chaseGapMs, checkRentalOutbound, draftRental, evaluate, needsTenantConsent, parseApplication, parseCriteria, parseRepair, parseSlots, pickOffers,
  rankApplications, repairDue, triage, RENTAL_MESSAGE_KINDS, type Criteria, type RepairContext, type RepairState
} from "../src/domain/elena-rentals";

const NOW = "2026-11-20T02:00:00.000Z";
const C: Criteria = { maxRentPct: 35, minHistoryMonths: 12, minReferences: 2, moveInFrom: "2026-12-01", moveInTo: "2026-12-20" };
const RENT = 60000; // $600 a week

describe("owner criteria", () => {
  it("accepts a valid set and rejects out-of-range values and inverted dates", () => {
    expect(parseCriteria({ maxRentPct: 35, minHistoryMonths: 12, minReferences: 2, moveInFrom: "2026-12-01", moveInTo: "2026-12-20" })).toMatchObject({ ok: true, value: C });
    expect(parseCriteria({ maxRentPct: 5, minHistoryMonths: 0, minReferences: 0 }).ok).toBe(false);
    expect(parseCriteria({ maxRentPct: 30, minHistoryMonths: 0, minReferences: 9 }).ok).toBe(false);
    expect(parseCriteria({ maxRentPct: 30, minHistoryMonths: 0, minReferences: 0, moveInFrom: "2026-12-20", moveInTo: "2026-12-01" }).ok).toBe(false);
    expect(parseCriteria({ maxRentPct: 30, minHistoryMonths: 0, minReferences: 0, moveInFrom: "2026-02-31" }).ok).toBe(false);
  });
});

describe("applications", () => {
  it("accepts a partial application and keeps dollars as cents", () => {
    const r = parseApplication({ weeklyIncome: "1,800", moveInDate: "2026-12-05" }, NOW);
    expect(r).toMatchObject({ ok: true, value: { weeklyIncomeCents: 180000, moveInDate: "2026-12-05", noteWithheld: false } });
    expect(parseApplication({}, NOW).ok).toBe(true);
  });
  it("rejects nonsense and far-off dates", () => {
    expect(parseApplication({ weeklyIncome: -5 }, NOW).ok).toBe(false);
    expect(parseApplication({ rentalHistoryMonths: 2.5 }, NOW).ok).toBe(false);
    expect(parseApplication({ moveInDate: "2030-01-01" }, NOW).ok).toBe(false);
    expect(parseApplication({ note: "x".repeat(501) }, NOW).ok).toBe(false);
  });
  it("keeps the note but withholds it when it names a protected attribute or has contact details", () => {
    const family = parseApplication({ note: "We are a young family with two small children" }, NOW);
    expect(family.ok && family.value.noteWithheld).toBe(true);
    const phone = parseApplication({ note: "Call me on 0412 345 678 any time" }, NOW);
    expect(phone.ok && phone.value.noteWithheld).toBe(true);
    const fine = parseApplication({ note: "Quiet, tidy, happy to sign a 12 month lease." }, NOW);
    expect(fine.ok && fine.value.noteWithheld).toBe(false);
  });
});

describe("screening", () => {
  it("compares only the four criteria and explains each in plain words", () => {
    const e = evaluate({ weeklyIncomeCents: 200000, rentalHistoryMonths: 24, referencesCount: 3, moveInDate: "2026-12-05" }, C, RENT);
    expect(e.criteria.map(c => c.key)).toEqual(["income", "history", "references", "move_in"]);
    expect(e.criteria.every(c => c.status === "met")).toBe(true);
    expect(e.criteria[0]!.reason).toContain("30%");
    expect(e.headline).toBe("Meets 4 of 4 criteria.");
  });
  it("marks what fails and what is simply not provided, and never treats no history as a failure", () => {
    const e = evaluate({ weeklyIncomeCents: 100000, rentalHistoryMonths: 0, moveInDate: "2027-01-15" }, C, RENT);
    const by = Object.fromEntries(e.criteria.map(c => [c.key, c.status]));
    expect(by).toEqual({ income: "not_met", history: "missing", references: "missing", move_in: "not_met" });
    expect(e.criteria.find(c => c.key === "history")!.reason).toContain("first-time renters");
    expect(e.missing).toEqual(["history", "references"]);
    expect(e.notMet).toBe(2);
  });
  it("skips criteria the owner did not set", () => {
    const e = evaluate({ weeklyIncomeCents: 200000 }, { maxRentPct: 35, minHistoryMonths: 0, minReferences: 0 }, RENT);
    expect(e.criteria.filter(c => c.status === "not_asked").map(c => c.key)).toEqual(["history", "references", "move_in"]);
    expect(e.headline).toBe("Meets 1 of 1 criteria.");
  });
  it("ranks by fewest not met, then most met, then fewest missing, then who applied first", () => {
    const mk = (id: string, createdAt: string, f: Parameters<typeof evaluate>[0]) => ({ id, createdAt, evaluation: evaluate(f, C, RENT) });
    const ranked = rankApplications([
      mk("late", "2026-11-03T00:00:00Z", { weeklyIncomeCents: 200000, rentalHistoryMonths: 24, referencesCount: 3, moveInDate: "2026-12-05" }),
      mk("fails", "2026-11-01T00:00:00Z", { weeklyIncomeCents: 90000, rentalHistoryMonths: 24, referencesCount: 3, moveInDate: "2026-12-05" }),
      mk("early", "2026-11-02T00:00:00Z", { weeklyIncomeCents: 200000, rentalHistoryMonths: 24, referencesCount: 3, moveInDate: "2026-12-05" }),
      mk("blank", "2026-11-01T00:00:00Z", {})
    ]);
    expect(ranked.map(r => r.id)).toEqual(["early", "late", "blank", "fails"]);
  });
  it("says in the UI note that protected attributes are not used", () => {
    expect(NOT_USED_NOTE).toMatch(/age, family, religion, race, disability, occupation/);
    expect(NOT_USED_NOTE).toMatch(/never declines/);
    expect(Object.keys(MISSING_PROMPT)).toHaveLength(4);
  });
});

describe("viewing times", () => {
  it("validates slots: in the future, within 60 days, capacity and duration bounds, de-duplicated and sorted", () => {
    const r = parseSlots({ slots: [{ startsAt: "2026-11-25T23:00:00Z" }, { startsAt: "2026-11-22T23:00:00Z", capacity: 3, durationMin: 20 }, { startsAt: "2026-11-22T23:00:00Z" }] }, NOW);
    expect(r).toMatchObject({ ok: true, value: [{ startsAt: "2026-11-22T23:00:00.000Z", capacity: 3, durationMin: 20 }, { startsAt: "2026-11-25T23:00:00.000Z", capacity: 1, durationMin: 15 }] });
    expect(parseSlots({ slots: [{ startsAt: "2026-11-20T02:30:00Z" }] }, NOW).ok).toBe(false);
    expect(parseSlots({ slots: [{ startsAt: "2027-06-01T00:00:00Z" }] }, NOW).ok).toBe(false);
    expect(parseSlots({ slots: [{ startsAt: "2026-11-25T23:00:00Z", capacity: 9 }] }, NOW).ok).toBe(false);
    expect(parseSlots({ slots: [] }, NOW).ok).toBe(false);
  });
  it("offers the next three free, open times at least an hour away", () => {
    const s = (id: string, startsAt: string, booked = 0, status = "open", capacity = 1) => ({ id, startsAt, booked, status, capacity });
    const out = pickOffers([s("past", "2026-11-20T02:30:00Z"), s("full", "2026-11-21T00:00:00Z", 1), s("gone", "2026-11-21T01:00:00Z", 0, "cancelled"), s("a", "2026-11-22T00:00:00Z"), s("b", "2026-11-21T03:00:00Z"), s("c", "2026-11-23T00:00:00Z"), s("d", "2026-11-24T00:00:00Z")], NOW);
    expect(out.map(x => x.id)).toEqual(["b", "a", "c"]);
  });
});

describe("repair triage", () => {
  it("rates danger as emergency with safety advice first", () => {
    expect(triage("gas", "I can smell gas in the kitchen")).toMatchObject({ urgency: "emergency", trade: "gas_fitter" });
    expect(triage("gas", "I can smell gas in the kitchen").advice).toMatch(/Leave the property/);
    expect(triage("plumbing", "A pipe has burst and water is pouring through the ceiling")).toMatchObject({ urgency: "emergency", trade: "plumber" });
    expect(triage("electrical", "Sparks came out of the power point")).toMatchObject({ urgency: "emergency", trade: "electrician" });
    expect(triage("locks_security", "Someone broke in and the back door will not lock")).toMatchObject({ urgency: "emergency", trade: "locksmith" });
  });
  it("rates lost essential services as urgent and the rest as routine", () => {
    expect(triage("plumbing", "We have no hot water since this morning").urgency).toBe("urgent");
    expect(triage("appliance", "The oven is not working").urgency).toBe("urgent");
    expect(triage("other", "A cupboard door hinge is loose").urgency).toBe("routine");
    expect(triage("other", "A cupboard door hinge is loose", false, true).urgency).toBe("urgent");
  });
  it("lets a tenant raise urgency to emergency but nothing lowers a rule-based emergency", () => {
    const t = triage("other", "Ceiling light flickers and the room feels unsafe", true);
    expect(t).toMatchObject({ urgency: "emergency" });
    expect(triage("plumbing", "gas smell", false, false).urgency).toBe("emergency");
  });
  it("validates a repair request and refuses contact details", () => {
    const id = "3c8cbf0e-2b6e-4b0f-9d57-6b3d1b8f0e11";
    expect(parseRepair({ tenancyId: id, category: "plumbing", description: "Kitchen tap drips all day", urgent: "true" })).toMatchObject({ ok: true, value: { urgent: true, emergency: false } });
    expect(parseRepair({ tenancyId: id, category: "plumbing", description: "short" }).ok).toBe(false);
    expect(parseRepair({ tenancyId: id, category: "nope", description: "Kitchen tap drips all day" }).ok).toBe(false);
    expect(parseRepair({ tenancyId: id, category: "plumbing", description: "Call me on 0412 345 678 about the tap" }).ok).toBe(false);
  });
});

describe("what Elena sends", () => {
  const vars = { address: "12 Smith St, Newtown", name: "Pat", ref: "RR-1001", category: "Plumbing", urgency: "urgent", reason: "A basic service is out", when: "Tue 25 Nov, 10:00 am", list: "Mon 24 Nov, 9:00 am", headline: "Meets 3 of 4 criteria.", missing: "how many references you can offer", contractor: "Gus", count: 2 };
  it("every message passes her own outbound check, mentions no amount and contains no link or address of a person", () => {
    for (const k of RENTAL_MESSAGE_KINDS) {
      const d = draftRental(k, vars);
      expect(checkRentalOutbound(d), k).toEqual({ ok: true });
      expect(d.body, k).not.toMatch(/\$\s?\d/);
      expect(d.body.length, k).toBeLessThan(900);
    }
  });
  it("an emergency tells the tenant to call 000 first, and a decline never gives a reason", () => {
    expect(draftRental("repair_received", { ...vars, urgency: "emergency", advice: "If anyone is in danger, call 000." }).body).toContain("call 000");
    const d = draftRental("decision_declined", vars).body;
    expect(d).toBe("Hi Pat, The owner of 12 Smith St, Newtown has chosen another applicant. Thanks for applying.");
  });
  it("blocks a message that would carry a phone number or an amount", () => {
    expect(checkRentalOutbound({ title: "x", body: "Call 0412 345 678" }).ok).toBe(false);
    expect(checkRentalOutbound({ title: "x", body: "That will be $250" }).ok).toBe(false);
  });
});

describe("repair chasing", () => {
  const r = (o: Partial<RepairState> = {}): RepairState => ({ id: "r1", status: "awaiting_owner", urgency: "routine", chases: 0, ...o });
  const ctx = (o: Partial<RepairContext> = {}): RepairContext => ({ assignmentStatus: "none", ...o });
  const sends = (steps: ReturnType<typeof repairDue>) => steps.filter(s => s.type === "send").map(s => (s as { to: string; kind: string }).to + ":" + (s as { kind: string }).kind);
  const patch = (steps: ReturnType<typeof repairDue>) => steps.filter(s => s.type === "set").map(s => (s as { patch: Record<string, unknown> }).patch)[0]!;

  it("nudges the owner on a schedule set by urgency and stops after three nudges", () => {
    expect(chaseGapMs("emergency")).toBeLessThan(chaseGapMs("urgent"));
    expect(chaseGapMs("urgent")).toBeLessThan(chaseGapMs("routine"));
    expect(sends(repairDue(r(), ctx(), NOW))).toEqual(["owner:repair_chase_owner"]);
    const stop = repairDue(r({ chases: 3 }), ctx(), NOW);
    expect(patch(stop)).toMatchObject({ status: "needs_owner", nextActionAt: null });
    expect(sends(stop)).toEqual(["owner:repair_needs_owner"]);
  });
  it("goes back to the owner with a new suggestion when the contractor declines", () => {
    const s = repairDue(r({ status: "offered" }), ctx({ assignmentStatus: "cancelled" }), NOW);
    expect(patch(s)).toMatchObject({ status: "awaiting_owner", reopenProposal: true });
    expect(sends(s)).toEqual(["owner:repair_contractor_declined"]);
  });
  it("tells both sides when a time is set, then checks with the tenant after the visit", () => {
    const at = "2026-11-25T00:00:00.000Z";
    const s = repairDue(r({ status: "offered" }), ctx({ assignmentStatus: "approved", scheduledAt: at, offeredAt: NOW }), NOW);
    expect(patch(s)).toMatchObject({ status: "scheduled" });
    expect(sends(s)).toEqual(["tenant:repair_scheduled", "owner:repair_scheduled"]);
    const after = repairDue(r({ status: "scheduled" }), ctx({ assignmentStatus: "approved", scheduledAt: at }), "2026-11-25T03:00:00.000Z");
    expect(patch(after)).toMatchObject({ status: "check_in" });
    const ask = repairDue(r({ status: "check_in" }), ctx(), NOW);
    expect(sends(ask)).toEqual(["tenant:repair_check"]);
    expect(patch(repairDue(r({ status: "check_in", chases: 3 }), ctx(), NOW))).toMatchObject({ status: "needs_owner" });
  });
  it("waits quietly for a contractor, nudges after a full gap, and hands back after three gaps", () => {
    const offeredAt = NOW;
    const quiet = repairDue(r({ status: "offered", urgency: "urgent" }), ctx({ assignmentStatus: "proposed", offeredAt }), "2026-11-20T04:00:00.000Z");
    expect(sends(quiet)).toEqual([]);
    const nudge = repairDue(r({ status: "offered", urgency: "urgent" }), ctx({ assignmentStatus: "proposed", offeredAt }), "2026-11-20T09:00:00.000Z");
    expect(sends(nudge)).toEqual(["owner:repair_chase_owner"]);
    const stop = repairDue(r({ status: "offered", urgency: "urgent", chases: 2 }), ctx({ assignmentStatus: "proposed", offeredAt }), "2026-11-21T09:00:00.000Z");
    expect(patch(stop)).toMatchObject({ status: "needs_owner" });
  });
  it("follows an emergency: tells everyone when accepted, flags a quiet half hour once, hands back when it expires", () => {
    const e = (status: "open" | "accepted" | "cancelled" | "expired", ageMinutes: number, quietNotified = false) => ctx({ emergency: { status, ageMinutes, quietNotified } });
    const st = r({ status: "emergency", urgency: "emergency" });
    expect(sends(repairDue(st, e("accepted", 12), NOW))).toEqual(["owner:repair_emergency_accepted", "tenant:repair_emergency_accepted"]);
    expect(sends(repairDue(st, e("open", 35), NOW))).toEqual(["owner:repair_emergency_quiet", "tenant:repair_emergency_quiet"]);
    expect(sends(repairDue(st, e("open", 40, true), NOW))).toEqual([]);
    expect(patch(repairDue(st, e("expired", 400), NOW))).toMatchObject({ status: "needs_owner" });
  });
  it("never acts on a closed or stopped repair", () => {
    expect(repairDue(r({ status: "closed" }), ctx(), NOW)).toEqual([]);
    expect(repairDue(r({ status: "needs_owner" }), ctx(), NOW)).toEqual([]);
  });
});

describe("entry notice", () => {
  it("needs the tenant's yes when a visit is under 24 hours away, except in an emergency", () => {
    expect(needsTenantConsent("2026-11-20T12:00:00Z", NOW, false)).toBe(true);
    expect(needsTenantConsent("2026-11-22T12:00:00Z", NOW, false)).toBe(false);
    expect(needsTenantConsent("2026-11-20T12:00:00Z", NOW, true)).toBe(false);
  });
});
