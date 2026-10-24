import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertDeliveryPort, DeliveryLogEntry } from "../src/domain/alerts";
import type { AlertPreference, SavedSearch } from "../src/domain/buyer";
import {
  createDraft, createInMemoryListingRepository, publishListing, type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import { createPublishAlertHook, type PublishAlertDeps } from "../src/domain/publish-alerts";
import { MAX_SAVED_LISTINGS, saveListing, unsaveListing, type SavedListingRepository, type SavedListingView } from "../src/domain/saved-listings";
import { createUnconfiguredAlertDelivery } from "../src/adapters/alert-delivery";
import type { Queryable } from "../src/server/db";
import { createPgSavedListingRepository } from "../src/server/saved-listing-db";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as unknown }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor }));
vi.mock("../src/server/saved-listing-context", () => ({ getSavedListingRepo: () => state.repo }));

import { GET as listRoute, POST as saveRoute } from "../app/api/buyer/saved-listings/route";
import { DELETE as deleteRoute } from "../app/api/buyer/saved-listings/[listingId]/route";
process.env["APP_URL"] = "http://test";

const L1 = "0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab";
const L2 = "0b1c2d3e-aaaa-4bbb-8ccc-1234567890ac";
const buyer: Actor = { userId: "b1", userType: "buyer" };
const owner: Actor = { userId: "o1", userType: "owner" };
const agent: Actor = { userId: "a1", userType: "agent" };

function memoryRepo(published: string[] = [L1, L2]): SavedListingRepository & { rows: { buyer: string; listing: string }[] } {
  const rows: { buyer: string; listing: string }[] = [];
  return {
    rows,
    async list(b) {
      return rows.filter(r => r.buyer === b).map((r): SavedListingView => ({ listingId: r.listing, title: "T", transactionType: "sale", savedAt: "x" }));
    },
    async add(b, l) {
      if (!published.includes(l)) return false;
      if (!rows.some(r => r.buyer === b && r.listing === l)) rows.push({ buyer: b, listing: l });
      return true;
    },
    async remove(b, l) {
      const i = rows.findIndex(r => r.buyer === b && r.listing === l);
      if (i >= 0) rows.splice(i, 1);
    },
    async count(b) { return rows.filter(r => r.buyer === b).length; }
  };
}

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://test/api/buyer/saved-listings", {
    method,
    headers: { origin: "http://test", "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
const ctx = (listingId: string) => ({ params: Promise.resolve({ listingId }) });

describe("saved-listings API", () => {
  let repo: ReturnType<typeof memoryRepo>;
  beforeEach(() => { repo = memoryRepo(); state.repo = repo; state.actor = buyer; });

  it("lets a buyer save, list and remove their own bookmark", async () => {
    expect((await saveRoute(req("POST", { listingId: L1 }))).status).toBe(201);
    expect((await saveRoute(req("POST", { listingId: L1 }))).status).toBe(201);
    expect(repo.rows).toHaveLength(1);
    const listed = await (await listRoute(req("GET"))).json();
    expect(listed.listings.map((l: SavedListingView) => l.listingId)).toEqual([L1]);
    expect((await deleteRoute(req("DELETE"), ctx(L1))).status).toBe(200);
    expect(repo.rows).toHaveLength(0);
  });

  it("denies signed-out callers", async () => {
    state.actor = null;
    expect((await listRoute(req("GET"))).status).toBe(401);
    expect((await saveRoute(req("POST", { listingId: L1 }))).status).toBe(401);
    expect((await deleteRoute(req("DELETE"), ctx(L1))).status).toBe(401);
  });

  it("denies owners and agents (buyers only)", async () => {
    for (const a of [owner, agent]) {
      state.actor = a;
      expect((await listRoute(req("GET"))).status).toBe(403);
      expect((await saveRoute(req("POST", { listingId: L1 }))).status).toBe(403);
      expect((await deleteRoute(req("DELETE"), ctx(L1))).status).toBe(403);
    }
    expect(repo.rows).toHaveLength(0);
  });

  it("rejects cross-origin and wrong content-type writes before anything else", async () => {
    expect((await saveRoute(req("POST", { listingId: L1 }, { origin: "http://evil.test" }))).status).toBe(403);
    expect((await saveRoute(req("POST", { listingId: L1 }, { "content-type": "text/plain" }))).status).toBe(403);
    expect((await deleteRoute(req("DELETE", undefined, { origin: "http://evil.test" }), ctx(L1))).status).toBe(403);
    expect(repo.rows).toHaveLength(0);
  });

  it("rejects malformed ids and refuses unknown or unpublished listings", async () => {
    for (const bad of [undefined, "", "abc", "1; DROP TABLE saved_listing", 5, null]) {
      expect((await saveRoute(req("POST", { listingId: bad }))).status).toBe(400);
    }
    expect((await saveRoute(req("POST"))).status).toBe(400);
    expect((await deleteRoute(req("DELETE"), ctx("not-a-uuid"))).status).toBe(400);
    expect((await saveRoute(req("POST", { listingId: "0b1c2d3e-aaaa-4bbb-8ccc-999999999999" }))).status).toBe(404);
  });

  it("removes only the caller's own bookmark", async () => {
    repo.rows.push({ buyer: "b2", listing: L1 });
    await deleteRoute(req("DELETE"), ctx(L1));
    expect(repo.rows).toEqual([{ buyer: "b2", listing: L1 }]);
  });

  it("caps bookmarks per buyer", async () => {
    for (let i = 0; i < MAX_SAVED_LISTINGS; i++) repo.rows.push({ buyer: "b1", listing: `x${i}` });
    const r = await saveListing(repo, buyer, L1);
    expect(!r.ok && r.code).toBe("conflict");
    expect((await unsaveListing(repo, owner, L1)).ok).toBe(false);
  });
});

describe("pg saved-listing repository", () => {
  it("uses parameterised SQL scoped to the buyer and only saves published listings", async () => {
    const calls: { text: string; params: unknown[] | undefined }[] = [];
    const db: Queryable = { async query(text, params) { calls.push({ text, params }); return { rows: [] }; } };
    const pg = createPgSavedListingRepository(db);
    expect(await pg.add("b1", L1)).toBe(false);
    await pg.remove("b1", L1);
    await pg.list("b1");
    await pg.count("b1");
    for (const c of calls) {
      expect(c.text).not.toContain("b1");
      expect(c.text).not.toContain(L1);
      expect(c.params?.[0]).toBe("b1");
      expect(c.text).toMatch(/buyer_user_id = \$1|SELECT \$1/);
    }
    expect(calls[0]!.text).toContain("status = 'published'");
    expect(calls.some(c => /DELETE FROM saved_listing WHERE buyer_user_id = \$1 AND listing_id = \$2/.test(c.text))).toBe(true);
  });
});

// ---------------------------------------------------------------- post-publish alert hook

const draft: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

async function publishable(extra: Partial<ListingServiceDeps>) {
  let n = 0;
  const repo = createInMemoryListingRepository();
  const deps: ListingServiceDeps = {
    repo, appendAudit: async () => undefined, now: () => "2026-10-24T00:00:00.000Z", newId: () => `id-${++n}`,
    requiredDisclosures: () => [], trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }), ...extra
  };
  const l = await createDraft(deps, owner, draft);
  const rec = await repo.get(l.id);
  await repo.save({ ...rec!, listingFeePaid: true, termsAccepted: true });
  return { deps, id: l.id, repo };
}

describe("afterPublish hook in publishListing", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("runs once with the published listing, and not on a dry run or a blocked publish", async () => {
    const hook = vi.fn(async () => undefined);
    const { deps, id } = await publishable({ afterPublish: hook });
    await publishListing(deps, owner, id, true);
    expect(hook).not.toHaveBeenCalled();
    await publishListing(deps, owner, id, false);
    expect(hook).toHaveBeenCalledTimes(1);
    expect((hook.mock.calls[0] as unknown as [{ status: string }])[0].status).toBe("published");

    const blockedHook = vi.fn(async () => undefined);
    const blocked = await publishable({ afterPublish: blockedHook, trustAccountFor: async () => undefined });
    const r = await publishListing(blocked.deps, owner, blocked.id, false);
    expect(r.ok && r.value.decision.allowed).toBe(false);
    expect(blockedHook).not.toHaveBeenCalled();
  });

  it("does not run for someone who may not publish", async () => {
    const hook = vi.fn(async () => undefined);
    const { deps, id } = await publishable({ afterPublish: hook });
    const r = await publishListing(deps, { userId: "stranger", userType: "owner" }, id, false);
    expect(r.ok).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });

  it("a hook that rejects or throws synchronously never fails or undoes publishing", async () => {
    for (const hook of [async () => { throw new Error("boom"); }, () => { throw new Error("sync boom"); }]) {
      const { deps, id, repo } = await publishable({ afterPublish: hook as NonNullable<ListingServiceDeps["afterPublish"]> });
      const r = await publishListing(deps, owner, id, false);
      expect(r.ok && r.value.listing.status).toBe("published");
      expect((await repo.get(id))?.listing.status).toBe("published");
    }
  });

  it("a hook that never finishes does not hold publishing past the timeout", async () => {
    vi.useFakeTimers();
    const { deps, id } = await publishable({ afterPublish: () => new Promise(() => undefined) });
    const p = publishListing(deps, owner, id, false);
    await vi.advanceTimersByTimeAsync(3100);
    const r = await p;
    expect(r.ok && r.value.listing.status).toBe("published");
  });
});

describe("createPublishAlertHook", () => {
  const consented: AlertPreference = { channel: "email", consentGivenAt: "2026-10-01T00:00:00.000Z" };
  const search = (id: string, buyerUserId: string, over: Partial<SavedSearch> = {}): SavedSearch => ({
    id, buyerUserId, transactionType: "sale", useClass: "residential", jurisdictions: [], suburbs: [], propertyTypes: [], active: true, ...over
  });
  let log: DeliveryLogEntry[];
  let sends: string[];
  const port: AlertDeliveryPort = { async send(m) { sends.push(`${m.buyerUserId}:${m.searchId}`); return "sent"; } };

  async function listing() {
    const { repo, id } = await publishable({});
    const rec = await repo.get(id);
    return { ...rec!.listing, status: "published" as const, suburb: "Paddington", priceCents: 80_000_000, bedrooms: 3 };
  }

  const make = (searches: SavedSearch[], prefs: Record<string, AlertPreference[]>, handled = { sentKeys: new Set<string>(), searchIds: new Set<string>() }, over: Partial<PublishAlertDeps> = {}) =>
    createPublishAlertHook({
      loadSearches: async () => searches, loadPrefs: async () => prefs, loadHandled: async () => handled,
      port, unsubscribeUrlFor: () => "http://test/buyer/saved-searches", now: () => "2026-10-24T01:00:00.000Z",
      log: async e => { log.push(e); }, ...over
    });

  beforeEach(() => { log = []; sends = []; });

  it("alerts a consenting buyer whose search matches, once per buyer even with two matching searches", async () => {
    const hook = make([search("s1", "b1"), search("s2", "b1", { suburbs: ["Paddington"] })], { b1: [consented] });
    const out = await hook(await listing());
    expect(out.map(e => e.outcome)).toEqual(["sent"]);
    expect(sends).toEqual(["b1:s1"]);
    expect(log).toHaveLength(1);
  });

  it("sends nothing without consent, after unsubscribe, for non-matching searches, or without an unsubscribe link", async () => {
    const l = await listing();
    await make([search("s1", "b1")], {})(l);
    await make([search("s1", "b1")], { b1: [{ channel: "email" }] })(l);
    await make([search("s1", "b1")], { b1: [{ ...consented, unsubscribedAt: "2026-10-02T00:00:00.000Z" }] })(l);
    await make([search("s1", "b1", { suburbs: ["Milton"] }), search("s2", "b1", { transactionType: "rent" })], { b1: [consented] })(l);
    expect(sends).toEqual([]);
    expect(log).toEqual([]);
    const out = await make([search("s1", "b1")], { b1: [consented] }, undefined, { unsubscribeUrlFor: () => "  " })(l);
    expect(out.map(e => e.outcome)).toEqual(["skipped_no_unsubscribe"]);
    expect(sends).toEqual([]);
  });

  it("dedupes per (search, listing): an attempted search is skipped on a re-run", async () => {
    const l = await listing();
    const handled = { sentKeys: new Set<string>(), searchIds: new Set(["s1"]) };
    const out = await make([search("s1", "b1")], { b1: [consented] }, handled)(l);
    expect(out).toEqual([]);
    expect(sends).toEqual([]);
    const sent = { sentKeys: new Set([`b1:email:${l.id}`]), searchIds: new Set<string>() };
    expect(await make([search("s9", "b1")], { b1: [consented] }, sent)(l)).toEqual([]);
  });

  it("with the fail-closed port nothing is ever delivered and the attempt is logged as not_configured", async () => {
    const out = await make([search("s1", "b1")], { b1: [consented] }, undefined, { port: createUnconfiguredAlertDelivery() })(await listing());
    expect(out.map(e => e.outcome)).toEqual(["not_configured"]);
  });

  it("does nothing when there are no saved searches", async () => {
    expect(await make([], {})(await listing())).toEqual([]);
  });
});
