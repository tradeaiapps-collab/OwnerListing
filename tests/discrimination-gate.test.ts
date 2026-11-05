import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldFlags } from "../src/domain/discrimination-filter";
import {
  createDraft, createInMemoryListingRepository, evaluateListingPublish, parseDraftInput, parseDraftPatch, publishListing, updateDraft,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import { checkSuggestion } from "../src/domain/ai-description";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as ListingServiceDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDeps: () => state.deps, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
// Publish step-up is covered in tests/mfa.test.ts; here the owner has just passed it.
vi.mock("../src/server/mfa-context", () => ({ requireRecentMfa: async () => null }));

import { POST as wordingCheck } from "../app/api/listings/wording-check/route";
import { PATCH as patchRoute } from "../app/api/listings/[id]/route";
import { POST as createRoute } from "../app/api/listings/route";
import { POST as publishRoute } from "../app/api/listings/[id]/publish/route";
process.env["APP_URL"] = "http://test";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const input: DraftInput = {
  title: "Renovated home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

let n = 0;
let recorded: { listingId: string; actor: string; fields: readonly FieldFlags[] }[];
let cleared: Set<string>;
let deps: ListingServiceDeps;

beforeEach(() => {
  n = 0;
  recorded = [];
  cleared = new Set();
  deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async () => {},
    now: () => "2026-10-25T00:00:00.000Z",
    newId: () => `id-${++n}`,
    requiredDisclosures: () => [],
    trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }),
    clearedWordingFlags: async () => cleared,
    recordWordingFlags: async (listingId, actor, fields) => { recorded.push({ listingId, actor, fields }); }
  };
  state.actor = null;
  state.deps = deps;
});

/** A draft that passes every other gate, so only the wording decides. */
async function ready(description?: string, title = input.title) {
  const l = await createDraft(deps, owner, { ...input, title, priceCents: 85_000_000, ...(description ? { description } : {}) });
  const rec = (await deps.repo.get(l.id))!;
  await deps.repo.save({ ...rec, listingFeePaid: true, termsAccepted: true });
  return l;
}

describe("description field", () => {
  it("is optional, trimmed, capped at 5000 characters and blank clears it", () => {
    expect(parseDraftInput({ ...input, description: "  Lovely home.  " })).toEqual({ ok: true, value: { ...input, description: "Lovely home." } });
    expect(parseDraftInput({ ...input, description: "" })).toEqual({ ok: true, value: input });
    expect(parseDraftInput({ ...input, description: "x".repeat(5001) }).ok).toBe(false);
    expect(parseDraftInput({ ...input, description: 42 }).ok).toBe(false);
    expect(parseDraftPatch({ description: "  " })).toEqual({ ok: true, value: { description: null } });
    expect(parseDraftPatch({ description: null })).toEqual({ ok: true, value: { description: null } });
  });

  it("is saved, changed and cleared on a draft", async () => {
    const l = await createDraft(deps, owner, { ...input, description: "First" });
    expect(l.description).toBe("First");
    const u = await updateDraft(deps, owner, l.id, { description: "Second" });
    expect(u.ok && u.value.description).toBe("Second");
    const c = await updateDraft(deps, owner, l.id, { description: null });
    expect(c.ok && "description" in c.value).toBe(false);
  });
});

describe("publish gate", () => {
  it("publishes clean wording (advice-only warnings do not block)", async () => {
    const l = await ready("Three bedrooms, fenced yard. Perfect for families.");
    const r = await publishListing(deps, owner, l.id, false);
    expect(r.ok && r.value.decision).toEqual({ allowed: true, reasons: [] });
    expect(r.ok && r.value.wordingFlags.flatMap(f => f.flags.map(x => x.severity))).toEqual(["warn"]);
    expect(recorded).toEqual([]);
  });

  it("blocks discriminatory wording in the description or title, explains it and records the flags", async () => {
    const l = await ready("Lovely home. No kids, no DSS.", "Christians only, quiet street");
    const r = await publishListing(deps, owner, l.id, false);
    if (!r.ok) throw new Error(r.message);
    expect(r.value.decision.allowed).toBe(false);
    expect(r.value.decision.reasons).toHaveLength(3);
    expect(r.value.decision.reasons[0]).toMatch(/title.*"Christians only"/);
    expect(r.value.decision.reasons.join(" ")).toMatch(/"No kids".*"no DSS"/);
    expect(r.value.listing.status).toBe("draft");
    expect((await deps.repo.get(l.id))!.listing.status).toBe("draft");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.fields.map(f => f.field)).toEqual(["title", "description"]);
  });

  it("does not record flags on a dry run, but still blocks", async () => {
    const l = await ready("Adults only.");
    const r = await publishListing(deps, owner, l.id, true);
    expect(r.ok && r.value.decision.allowed).toBe(false);
    expect(recorded).toEqual([]);
  });

  it("lets a match staff cleared for this listing publish, and only that match", async () => {
    const l = await ready("Over 55s only community.");
    cleared.add("description:over 55s only");
    const ok = await publishListing(deps, owner, l.id, true);
    expect(ok.ok && ok.value.decision.allowed).toBe(true);
    await updateDraft(deps, owner, l.id, { description: "Over 55s only community. No pensioners." });
    const again = await publishListing(deps, owner, l.id, true);
    expect(again.ok && again.value.decision.reasons).toEqual([expect.stringMatching(/"No pensioners"/)]);
  });

  it("fails closed when the cleared list cannot be read", async () => {
    const l = await ready("Over 55s only.");
    const broken = { ...deps, clearedWordingFlags: async () => { throw new Error("db down"); } };
    const r = await publishListing(broken, owner, l.id, true);
    expect(r.ok && r.value.decision.allowed).toBe(false);
  });

  it("still blocks when recording the flags fails", async () => {
    const l = await ready("No kids.");
    const broken = { ...deps, recordWordingFlags: async () => { throw new Error("db down"); } };
    const r = await publishListing(broken, owner, l.id, false);
    expect(r.ok && r.value.decision.allowed).toBe(false);
  });

  it("is part of the shared gate, so staff reinstating a listing get the same block and nothing is recorded", async () => {
    const l = await ready("Lovely home. No kids.");
    const rec = (await deps.repo.get(l.id))!;
    const d = await evaluateListingPublish(deps, rec, deps.now(), owner.userId);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/"No kids"/);
    expect(recorded).toHaveLength(0);
    expect((await evaluateListingPublish(deps, (await deps.repo.get((await ready("Lovely home.")).id))!, deps.now(), owner.userId)).allowed).toBe(true);
  });

  it("adds the wording reasons alongside other blockers", async () => {
    const l = await createDraft(deps, owner, { ...input, description: "No kids." });
    const r = await publishListing(deps, owner, l.id, true);
    const reasons = r.ok ? r.value.decision.reasons : [];
    expect(reasons.some(x => /fee/i.test(x))).toBe(true);
    expect(reasons.some(x => /"No kids"/.test(x))).toBe(true);
  });
});

describe("AI description backstop", () => {
  it("rejects an AI draft with discriminatory wording", () => {
    expect(checkSuggestion("Bright three-bedroom home close to the train.")).toBe(true);
    expect(checkSuggestion("Bright three-bedroom home, ideal for Christian buyers.")).toBe(false);
  });
});

const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://test${url}`, {
    method, headers: { "content-type": "application/json", origin: "http://test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

describe("routes", () => {
  it("POST /api/listings/wording-check needs a signed-in user and returns the flags", async () => {
    expect((await wordingCheck(req("POST", "/api/listings/wording-check", { text: "No kids" }))).status).toBe(401);
    state.actor = owner;
    const r = await wordingCheck(req("POST", "/api/listings/wording-check", { text: "Lovely home. No kids." }));
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.blocked).toBe(true);
    expect(d.flags[0]).toMatchObject({ match: "No kids", severity: "block", category: "familial_status" });
    expect((await wordingCheck(req("POST", "/api/listings/wording-check", { text: 7 }))).status).toBe(400);
    expect((await wordingCheck(req("POST", "/api/listings/wording-check", { text: "x".repeat(5001) }))).status).toBe(400);
  });

  it("create and PATCH return the wording flags with the saved draft", async () => {
    state.actor = owner;
    deps.termsCurrentFor = async () => true;
    const c = await createRoute(req("POST", "/api/listings", { ...input, description: "Female only." }));
    expect(c.status).toBe(201);
    const created = await c.json();
    expect(created.wordingFlags).toEqual([{ field: "description", flags: [expect.objectContaining({ match: "Female only", severity: "block" })] }]);
    const p = await patchRoute(req("PATCH", `/api/listings/${created.listing.id}`, { description: "Furnished room, private bathroom." }),
      { params: Promise.resolve({ id: created.listing.id }) });
    const patched = await p.json();
    expect(patched.listing.description).toBe("Furnished room, private bathroom.");
    expect(patched.wordingFlags).toEqual([]);
  });

  it("publish returns the decision with the wording flags", async () => {
    state.actor = owner;
    const l = await ready("No students.");
    const r = await publishRoute(req("POST", `/api/listings/${l.id}/publish`), { params: Promise.resolve({ id: l.id }) });
    const d = await r.json();
    expect(d.decision.allowed).toBe(false);
    expect(d.wordingFlags[0].flags[0].match).toBe("No students");
  });
});

describe("AI pipeline wording filter", () => {
  it("is the real filter: installed, holds discriminatory drafts, passes clean ones", async () => {
    const { getWordingFilter } = await import("../src/server/wording-filter");
    const { guardDraft } = await import("../src/domain/ai-output-guard");
    const f = getWordingFilter();
    expect(f("Thanks for asking, inspections are on Saturday.")).toEqual({ blocked: false, flags: [], installed: true });
    const hit = f("Sorry, the owner prefers no kids.");
    expect(hit).toMatchObject({ blocked: true, installed: true, flags: [expect.objectContaining({ category: "familial_status" })] });
    expect(f("Perfect for families.").blocked).toBe(false);
    expect(f("a".repeat(20_001)).blocked).toBe(true);
    expect(guardDraft("Suits Christians only.", { wordingFilter: f, allowedAmountsCents: [] }).violations.map(v => v.code)).toContain("wording_filter");
  });
});
