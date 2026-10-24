import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import type { AiEnginePort } from "../src/domain/ai-engine";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import { buildContractDraft, canDraftFrom, DRAFT_LABEL } from "../src/domain/contract-draft";
import { compareOffers, requestAiSummary, type AnalysisOffer } from "../src/domain/offer-analysis";
import {
  createDraft, createInMemoryListingRepository,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  deps: null as ListingServiceDeps | null,
  db: null as Queryable | null,
  engine: null as AiEnginePort | null
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps,
  getDb: () => state.db
}));
vi.mock("../src/server/ai", () => ({ getAiEngine: () => state.engine }));

import { GET as analysisGet, POST as analysisPost } from "../app/api/listings/[id]/offer-analysis/route";
import { POST as draftPost } from "../app/api/listings/[id]/contract-draft/route";
process.env["APP_URL"] = "http://test";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};
const NOW = "2026-10-24T00:00:00.000Z";
const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const O3 = "33333333-3333-4333-8333-333333333333";

const offer = (id: string, p: number, d: number, s: number, c: string[] = [], status = "submitted", at = NOW): AnalysisOffer =>
  ({ id, priceCents: p, depositCents: d, settlementDays: s, conditions: c, status, submittedAt: at });

const selfHosted = (generate: () => Promise<string>): AiEnginePort => ({
  info: () => ({ id: "x", kind: "self_hosted", version: "1" }),
  readDocument: async () => "", describePhoto: async () => [], generate
});

describe("compareOffers (no AI)", () => {
  it("sorts by price desc, deposit desc, settlement asc, fewer conditions, then time and id", () => {
    const rows = compareOffers([
      offer("c", 900, 90, 30), offer("a", 1000, 50, 60), offer("b", 1000, 100, 60),
      offer("d", 1000, 100, 30, ["Finance"]), offer("e", 1000, 100, 30)
    ]);
    expect(rows.map(r => r.id)).toEqual(["e", "d", "b", "a", "c"]);
    expect(rows.map(r => r.label)).toEqual(["Offer A", "Offer B", "Offer C", "Offer D", "Offer E"]);
    expect(rows[0]!.depositPercent).toBe(10);
  });
  it("is stable for identical offers and does not change its input", () => {
    const input = [offer("b", 1, 1, 1), offer("a", 1, 1, 1)];
    expect(compareOffers(input).map(r => r.id)).toEqual(["a", "b"]);
    expect(input.map(o => o.id)).toEqual(["b", "a"]);
  });
  it("handles no offers and a zero price", () => {
    expect(compareOffers([])).toEqual([]);
    expect(compareOffers([offer("a", 0, 0, 1)])[0]!.depositPercent).toBe(0);
  });
});

describe("requestAiSummary fails closed", () => {
  const rows = compareOffers([offer("a", 1000, 100, 30)]);
  it("says unavailable when the engine is off, without calling it", async () => {
    const spy = vi.spyOn(rulesOnlyEngine, "generate");
    const r = await requestAiSummary(rulesOnlyEngine, rows);
    expect(r.state).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });
  it("says unavailable when the engine throws or returns nothing", async () => {
    expect((await requestAiSummary(selfHosted(async () => { throw new Error("down"); }), rows)).state).toBe("unavailable");
    expect((await requestAiSummary(selfHosted(async () => "  "), rows)).state).toBe("unavailable");
  });
  it("drops AI text that steers the owner's decision", async () => {
    for (const t of ["You should accept Offer A.", "I recommend rejecting B.", "Offer A is the best offer.", "Counter at a higher price."]) {
      expect((await requestAiSummary(selfHosted(async () => t), rows)).state).toBe("unavailable");
    }
  });
  it("passes a neutral summary, and the prompt carries no buyer identity", async () => {
    let prompt = "";
    const eng = selfHosted(async () => "Offer A has the highest price and a 30 day settlement.");
    eng.generate = async p => { prompt = p; return "Offer A has the highest price and a 30 day settlement."; };
    const r = await requestAiSummary(eng, rows);
    expect(r.state).toBe("ready");
    expect(prompt).toContain("Offer A");
    expect(prompt).not.toContain('"a"');
  });
});

describe("buildContractDraft", () => {
  const listing = { address: "1 Example St", jurisdiction: "QLD", transactionType: "sale" as const, useClass: "residential", propertyType: "house" };
  it("labels the draft and uses the offer terms for a sale", () => {
    const d = buildContractDraft(listing, { priceCents: 90_000_000, depositCents: 9_000_000, settlementDays: 30, conditions: ["Finance approval"] });
    expect(d.label).toBe(DRAFT_LABEL);
    expect(d.label.toLowerCase()).toContain("not legal advice");
    expect(d.label.toLowerCase()).toContain("solicitor to review");
    const text = JSON.stringify(d);
    expect(text).toContain("$900,000.00");
    expect(text).toContain("trust account");
    expect(text).toContain("1. Finance approval");
  });
  it("uses lease wording for a rental", () => {
    const d = buildContractDraft({ ...listing, transactionType: "rent" }, { priceCents: 60_000, depositCents: 120_000, settlementDays: 14, conditions: [] });
    expect(d.title).toBe("Draft lease agreement");
    expect(JSON.stringify(d)).toContain("None stated");
  });
  it("only drafts from live offers", () => {
    expect(canDraftFrom("submitted")).toBe(true);
    expect(canDraftFrom("rejected")).toBe(false);
    expect(canDraftFrom("withdrawn")).toBe(false);
  });
});

let n: number;
let audit: AuditEvent[];
let calls: string[];
let offerRows: Record<string, unknown>[];
let listingId: string;

const row = (id: string, price: number, status = "submitted") => ({
  id, price_cents: String(price), conditions: ["Finance approval"], settlement_days: 30,
  deposit_cents: String(price / 10), status, submitted_at: NOW, buyer_user_id: "buyer-9"
});
const ctx = () => ({ params: Promise.resolve({ id: listingId }) });
const post = (url: string, body: unknown, headers: Record<string, string> = { origin: "http://test" }) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(async () => {
  n = 0; audit = []; calls = [];
  state.actor = null;
  state.engine = rulesOnlyEngine;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async e => { audit.push(e); },
    now: () => NOW,
    newId: () => `id-${++n}`,
    requiredDisclosures: () => []
  };
  state.db = {
    async query(text) {
      calls.push(text);
      return { rows: text.includes("FROM formal_offer o") ? offerRows : [] };
    }
  };
  listingId = (await createDraft(state.deps, owner, input)).id;
  audit = [];
  offerRows = [row(O1, 80_000_000), row(O2, 90_000_000), row(O3, 95_000_000, "rejected")];
});

const others: [string, Actor][] = [
  ["another owner", { userId: "owner-2", userType: "owner" }],
  ["an agent", { userId: "agent-1", userType: "agent" }],
  ["a buyer", { userId: "buyer-9", userType: "buyer" }]
];

describe("/api/listings/[id]/offer-analysis", () => {
  it("401 when signed out, 404 for others and unknown listings, before reading any offers", async () => {
    expect((await analysisGet(new Request("http://test/x"), ctx())).status).toBe(401);
    for (const [, a] of others) {
      state.actor = a;
      expect((await analysisGet(new Request("http://test/x"), ctx())).status).toBe(404);
      expect((await analysisPost(post("http://test/x", {}), ctx())).status).toBe(404);
    }
    state.actor = owner;
    expect((await analysisGet(new Request("http://test/x"), { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
    expect(calls.filter(c => c.includes("FROM formal_offer o"))).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
  it("POST rejects a request without the same-origin header (CSRF), before anything else", async () => {
    state.actor = owner;
    const res = await analysisPost(post("http://test/x", {}, {}), ctx());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(404);
    expect(calls).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
  it("GET gives the sorted table with no buyer identity and never calls the AI", async () => {
    state.actor = owner;
    state.engine = selfHosted(async () => { throw new Error("must not be called"); });
    const res = await analysisGet(new Request("http://test/x"), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual([O3, O2, O1]);
    expect(body.ai).toEqual({ state: "not_requested" });
    expect(JSON.stringify(body)).not.toContain("buyer-9");
  });
  it("POST with the AI off returns the table plus an 'AI unavailable' state and audits it", async () => {
    state.actor = owner;
    const res = await analysisPost(post("http://test/x", {}), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ai.state).toBe("unavailable");
    expect(body.ai.message).toContain("AI unavailable");
    expect(body.rows).toHaveLength(3);
    expect(audit.map(a => a.eventType)).toEqual(["offer_analysis.ai_requested"]);
    expect(audit[0]!.payload).toMatchObject({ aiState: "unavailable" });
  });
  it("POST with a working engine returns its checked summary; a decision-steering one is dropped", async () => {
    state.actor = owner;
    state.engine = selfHosted(async () => "Offer A has the highest price.");
    expect((await (await analysisPost(post("http://test/x", {}), ctx())).json()).ai.state).toBe("ready");
    state.engine = selfHosted(async () => "Accept Offer A now.");
    expect((await (await analysisPost(post("http://test/x", {}), ctx())).json()).ai.state).toBe("unavailable");
  });
  it("never records a decision on an offer", async () => {
    state.actor = owner;
    await analysisPost(post("http://test/x", {}), ctx());
    expect(calls.filter(c => /UPDATE|INSERT|DELETE/i.test(c))).toHaveLength(0);
  });
});

describe("POST /api/listings/[id]/contract-draft", () => {
  const draft = (body: unknown, headers?: Record<string, string>) => draftPost(post("http://test/x", body, headers), ctx());
  it("401 when signed out; 404 for others and unknown listings, before reading offers", async () => {
    expect((await draft({ offerId: O1 })).status).toBe(401);
    for (const [, a] of others) {
      state.actor = a;
      expect((await draft({ offerId: O1 })).status).toBe(404);
    }
    state.actor = owner;
    expect((await draftPost(post("http://test/x", { offerId: O1 }), { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
    expect(calls.filter(c => c.includes("FROM formal_offer o"))).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
  it("rejects a request without the same-origin header (CSRF)", async () => {
    state.actor = owner;
    const res = await draft({ offerId: O1 }, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
  });
  it("400 for a missing or malformed offer id; 404 for an offer that is not on this listing", async () => {
    state.actor = owner;
    expect((await draft({})).status).toBe(400);
    expect((await draft({ offerId: "offer-1" })).status).toBe(400);
    expect((await draft({ offerId: "44444444-4444-4444-8444-444444444444" })).status).toBe(404);
  });
  it("409 for a rejected offer", async () => {
    state.actor = owner;
    expect((await draft({ offerId: O3 })).status).toBe(409);
    expect(audit).toHaveLength(0);
  });
  it("returns a labelled draft, audits the preview, stores nothing and records no decision", async () => {
    state.actor = owner;
    const res = await draft({ offerId: O2 });
    expect(res.status).toBe(200);
    const { draft: d } = await res.json();
    expect(d.label).toBe(DRAFT_LABEL);
    expect(JSON.stringify(d)).toContain("$900,000.00");
    expect(JSON.stringify(d)).not.toContain("buyer-9");
    expect(audit.map(a => a.eventType)).toEqual(["contract_draft.previewed"]);
    expect(calls.filter(c => /UPDATE|INSERT|DELETE/i.test(c))).toHaveLength(0);
  });
});
