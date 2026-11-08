import { describe, expect, it } from "vitest";
import { advance, CAMPAIGN_TEMPLATES, describeMinutes, evalGroup, mergeText, parseDefinition, simulate, startRun, type WorkflowDefinition } from "../src/domain/automation";

const NOW = "2026-11-05T00:00:00.000Z";
const later = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();
const def = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ trigger: "new_lead", when: { match: "all", conditions: [] }, steps, ...extra });
const send = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "send", channel: "email", to: "contact", subject: "Hi", body: "Hello {{contact_first_name}}", ...extra });
const ok = (raw: unknown): WorkflowDefinition => { const r = parseDefinition(raw); if (!r.ok) throw new Error(r.message); return r.value; };

describe("conditions", () => {
  it("handles all/any, numbers, text, and never matches a missing fact", () => {
    const facts = { enquiries_on_listing: 5, listing_title: "Beach House" };
    const g = (match: "all" | "any", c: object[]) => ({ match, conditions: c }) as never;
    expect(evalGroup(g("all", [{ field: "enquiries_on_listing", op: "gte", value: 5 }, { field: "listing_title", op: "contains", value: "beach" }]), facts)).toBe(true);
    expect(evalGroup(g("all", [{ field: "enquiries_on_listing", op: "gt", value: 5 }, { field: "listing_title", op: "contains", value: "beach" }]), facts)).toBe(false);
    expect(evalGroup(g("any", [{ field: "enquiries_on_listing", op: "gt", value: 5 }, { field: "listing_title", op: "eq", value: "BEACH HOUSE" }]), facts)).toBe(true);
    expect(evalGroup(g("all", [{ field: "offer_price", op: "neq", value: 1 }]), facts)).toBe(false);
    expect(evalGroup(g("all", []), {})).toBe(true);
  });
});

describe("merge fields", () => {
  it("fills known facts, blanks unknown names and strips control characters", () => {
    expect(mergeText("Hi {{contact_first_name}} {{secret}} {{offer_price}}", { contact_first_name: "Sam", offer_price: 850000 })).toBe("Hi Sam  $850,000");
    expect(mergeText("a\u0007b", {})).toBe("a b");
  });
});

describe("validation", () => {
  it("accepts every starter campaign", () => { for (const t of CAMPAIGN_TEMPLATES) expect(parseDefinition(t.definition).ok, t.key).toBe(true); });
  it("rejects loops, unknown targets, duplicate ids and over-long plans", () => {
    const branch = (to: string) => ({ id: "b", kind: "branch", when: { match: "all", conditions: [{ field: "enquiries_on_listing", op: "gt", value: 1 }] }, then: to, otherwise: "end" });
    expect(parseDefinition(def([send("a"), branch("a")])).ok).toBe(false);
    expect(parseDefinition(def([branch("b")])).ok).toBe(false);
    expect(parseDefinition(def([branch("zzz"), send("a")])).ok).toBe(false);
    expect(parseDefinition(def([send("a"), send("a")])).ok).toBe(false);
    expect(parseDefinition(def([{ id: "w1", kind: "wait", minutes: 30 * 1440 }, { id: "w2", kind: "wait", minutes: 30 * 1440 }, { id: "w3", kind: "wait", minutes: 1440 }])).ok).toBe(false);
    expect(parseDefinition(def(Array.from({ length: 21 }, (_, i) => send(`s${i}`)))).ok).toBe(false);
    expect(parseDefinition(def([])).ok).toBe(false);
  });
  it("blocks messaging a contact where none exists, and merge fields the trigger lacks", () => {
    expect(parseDefinition(def([send("a")], { trigger: "property_listed" })).ok).toBe(false);
    expect(parseDefinition(def([send("a", { to: "owner", body: "{{offer_price}}" })])).ok).toBe(false);
    expect(parseDefinition(def([send("a", { to: "owner", body: "{{listing_title}}" })])).ok).toBe(true);
  });
  it("rejects wrong operators and non-numeric values", () => {
    expect(parseDefinition(def([send("a")], { when: { match: "all", conditions: [{ field: "listing_title", op: "gt", value: "x" }] } })).ok).toBe(false);
    expect(parseDefinition(def([send("a")], { when: { match: "all", conditions: [{ field: "enquiries_on_listing", op: "gt", value: "lots" }] } })).ok).toBe(false);
  });
});

describe("state machine", () => {
  it("sends, waits for the delay, then resumes at the next step", () => {
    const d = ok(def([send("a"), { id: "w", kind: "wait", minutes: 120 }, send("b")]));
    const start = startRun(d, { contact_first_name: "Sam" }, NOW);
    if ("skipped" in start) throw new Error("skipped");
    const one = advance(d, start.state, { contact_first_name: "Sam" }, NOW);
    expect(one.actions.map(a => [a.stepId, a.body])).toEqual([["a", "Hello Sam"]]);
    expect(one.state).toEqual({ status: "waiting", stepIndex: 2, wakeAt: later(120) });
    expect(advance(d, one.state, {}, later(60))).toMatchObject({ actions: [], state: one.state }); // too early: unchanged
    const two = advance(d, one.state, { contact_first_name: "Sam" }, later(121));
    expect(two.actions.map(a => a.stepId)).toEqual(["b"]);
    expect(two.state.status).toBe("completed");
    expect(advance(d, two.state, {}, later(500)).actions).toEqual([]); // finished runs stay finished
  });
  it("branches on the facts, can end early, and stop ends the run", () => {
    const d = ok(def([
      { id: "br", kind: "branch", when: { match: "all", conditions: [{ field: "enquiries_on_listing", op: "gte", value: 3 }] }, then: "hot", otherwise: "cold" },
      send("hot", { body: "hot" }), { id: "st", kind: "stop" }, send("cold", { body: "cold" })]));
    const run = (n: number) => advance(d, { status: "running", stepIndex: 0, wakeAt: NOW }, { enquiries_on_listing: n }, NOW);
    expect(run(5).actions.map(a => a.body)).toEqual(["hot"]);
    expect(run(5).state.status).toBe("stopped");
    expect(run(1).actions.map(a => a.body)).toEqual(["cold"]);
    const early = ok(def([{ id: "br", kind: "branch", when: { match: "all", conditions: [{ field: "enquiries_on_listing", op: "gt", value: 1 }] }, then: "end", otherwise: "s" }, send("s")]));
    expect(advance(early, { status: "running", stepIndex: 0, wakeAt: NOW }, { enquiries_on_listing: 2 }, NOW)).toMatchObject({ actions: [], state: { status: "completed" } });
  });
  it("skips a run whose trigger filter does not match", () => {
    const d = ok(def([send("a")], { when: { match: "all", conditions: [{ field: "listing_title", op: "contains", value: "villa" }] } }));
    expect(startRun(d, { listing_title: "Beach House" }, NOW)).toHaveProperty("skipped");
    expect(startRun(d, { listing_title: "Grand Villa" }, NOW)).toHaveProperty("state");
  });
  it("simulate walks the whole plan with waits skipped and sends nothing", () => {
    const t = CAMPAIGN_TEMPLATES.find(x => x.key === "lead_nurture")!.definition;
    const r = simulate(t, { listing_title: "1 Test St", contact_first_name: "Sam" });
    expect(r.matched).toBe(true);
    expect(r.steps.filter(s => s.text.startsWith("EMAIL")).length).toBe(3);
    expect(r.steps.some(s => s.text === "Waiting 2 days.")).toBe(true);
  });
  it("describes delays", () => { expect([describeMinutes(1), describeMinutes(90), describeMinutes(120), describeMinutes(2880)]).toEqual(["1 minute", "90 minutes", "2 hours", "2 days"]); });
});
