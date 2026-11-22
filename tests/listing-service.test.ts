import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import {
  createDraft, createInMemoryListingRepository, getListing, parseDraftInput, parseDraftPatch,
  publishListing, searchPublished, updateDraft,
  type Actor, type DraftCreate, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import type { SearchQuery } from "../src/domain/listing-search";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const other: Actor = { userId: "owner-2", userType: "owner" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

let n = 0;
let audit: AuditEvent[];
let repo: ReturnType<typeof createInMemoryListingRepository>;
let deps: ListingServiceDeps;

beforeEach(() => {
  n = 0;
  audit = [];
  repo = createInMemoryListingRepository();
  deps = {
    repo,
    appendAudit: async e => { audit.push(e); },
    now: () => `2026-10-23T00:00:${String(n).padStart(2, "0")}.000Z`,
    newId: () => `id-${++n}`,
    requiredDisclosures: () => []
  };
});

describe("parseDraftInput", () => {
  it("accepts a complete draft and trims text", () => {
    const r = parseDraftInput({ ...input, title: "  Family home  " });
    expect(r).toEqual({ ok: true, value: input });
  });
  it("rejects missing fields, bad enums and non-objects", () => {
    expect(parseDraftInput(null).ok).toBe(false);
    expect(parseDraftInput({ ...input, title: "" }).ok).toBe(false);
    expect(parseDraftInput({ ...input, jurisdiction: "XX" }).ok).toBe(false);
    expect(parseDraftInput({ ...input, propertyType: "castle" }).ok).toBe(false);
  });
});

describe("language check on public text", () => {
  const msg = "Description contains inappropriate language. Please revise before posting.";
  it("rejects swearing in the title or description of a new draft, unless allowFlagged", () => {
    expect(parseDraftInput({ ...input, description: "What the f**k a view" })).toEqual({ ok: false, code: "invalid", message: msg });
    expect(parseDraftInput({ ...input, title: "Shit house" })).toEqual({ ok: false, code: "invalid", message: msg });
    expect(parseDraftInput({ ...input, title: "Shit house", allowFlagged: true }).ok).toBe(true);
    expect(parseDraftInput({ ...input, description: "Bright home near the park" }).ok).toBe(true);
  });
  it("rejects it on an update too", () => {
    expect(parseDraftPatch({ description: "kys" })).toEqual({ ok: false, code: "invalid", message: msg });
    expect(parseDraftPatch({ description: "kys", allowFlagged: true }).ok).toBe(true);
  });
});

describe("parseDraftPatch", () => {
  it("keeps only known fields and rejects empty or invalid patches", () => {
    expect(parseDraftPatch({ title: "New", ownerUserId: "evil" })).toEqual({ ok: true, value: { title: "New" } });
    expect(parseDraftPatch({}).ok).toBe(false);
    expect(parseDraftPatch({ useClass: "mixed" }).ok).toBe(false);
  });
});

describe("drafts", () => {
  it("creates an unpublished draft owned by the actor, unpaid, with an audit event", async () => {
    const l = await createDraft(deps, owner, input);
    expect(l.status).toBe("draft");
    expect(l.ownerUserId).toBe("owner-1");
    expect((await repo.get(l.id))?.listingFeePaid).toBe(false);
    expect(audit.map(e => e.eventType)).toEqual(["listing.created"]);
  });

  it("lets only the owner edit, and only while a draft", async () => {
    const l = await createDraft(deps, owner, input);
    const ok = await updateDraft(deps, owner, l.id, { title: "Renamed" });
    expect(ok.ok && ok.value.title).toBe("Renamed");
    const notOwner = await updateDraft(deps, other, l.id, { title: "Hijack" });
    expect(!notOwner.ok && notOwner.code).toBe("not_found");
    const rec = await repo.get(l.id);
    await repo.save({ ...rec!, listing: { ...rec!.listing, status: "published" } });
    const locked = await updateDraft(deps, owner, l.id, { title: "Late" });
    expect(!locked.ok && locked.code).toBe("conflict");
  });

  it("hides drafts from everyone except the owner", async () => {
    const l = await createDraft(deps, owner, input);
    expect((await getListing(deps, owner, l.id)).ok).toBe(true);
    expect((await getListing(deps, other, l.id)).ok).toBe(false);
    expect((await getListing(deps, null, l.id)).ok).toBe(false);
  });
});

describe("publishing", () => {
  it("blocks when no disclosure configuration exists (fail closed)", async () => {
    const l = await createDraft({ ...deps, requiredDisclosures: () => null }, owner, input);
    const r = await publishListing({ ...deps, requiredDisclosures: () => null }, owner, l.id, false);
    expect(r.ok && r.value.decision.allowed).toBe(false);
    expect(r.ok && r.value.listing.status).toBe("draft");
  });

  it("blocks until fee, terms and trust account are in place", async () => {
    const l = await createDraft(deps, owner, input);
    const r = await publishListing(deps, owner, l.id, false);
    expect(r.ok && r.value.decision.allowed).toBe(false);
    const reasons = r.ok ? r.value.decision.reasons.join(" ") : "";
    expect(reasons).toContain("listing fee");
    expect(reasons).toContain("terms and conditions");
    expect(reasons).toContain("Trust account");
    expect((await repo.get(l.id))?.listing.status).toBe("draft");
  });

  it("blocks publishing a sale or a rental that has no price, and changes nothing", async () => {
    for (const tx of ["sale", "rent"] as const) {
      const l = await createDraft(deps, owner, { ...input, transactionType: tx });
      const rec = await repo.get(l.id);
      await repo.save({ ...rec!, listingFeePaid: true, termsAccepted: true, rentalBondPathway: "state_bond_authority" });
      const ready = { ...deps, trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }) };
      const r = await publishListing(ready, owner, l.id, false);
      expect(r.ok && r.value.decision.allowed).toBe(false);
      expect(r.ok && r.value.decision.reasons).toContain(tx === "rent" ? "Weekly rent is required to publish." : "An asking price is required to publish.");
      expect((await repo.get(l.id))?.listing.status).toBe("draft");
    }
  });

  it("publishes through pending_review with audit events once every gate passes", async () => {
    const l = await createDraft(deps, owner, { ...input, priceCents: 85_000_000 });
    const rec = await repo.get(l.id);
    await repo.save({ ...rec!, listingFeePaid: true, termsAccepted: true });
    const ready = { ...deps, trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }) };
    const dry = await publishListing(ready, owner, l.id, true);
    expect(dry.ok && dry.value.decision.allowed).toBe(true);
    expect((await repo.get(l.id))?.listing.status).toBe("draft");
    const live = await publishListing(ready, owner, l.id, false);
    expect(live.ok && live.value.listing.status).toBe("published");
    expect(audit.map(e => e.eventType)).toEqual(["listing.created", "listing.pending_review", "listing.published"]);
  });

  it("refuses to publish a listing staff have suspended, and leaves it suspended", async () => {
    const l = await createDraft(deps, owner, { ...input, priceCents: 85_000_000 });
    const rec = await repo.get(l.id);
    await repo.save({ ...rec!, listing: { ...rec!.listing, status: "suspended" }, listingFeePaid: true, termsAccepted: true });
    const ready = { ...deps, trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }) };
    const r = await publishListing(ready, owner, l.id, false);
    expect(!r.ok && r.code).toBe("conflict");
    expect((await repo.get(l.id))?.listing.status).toBe("suspended");
  });

  it("does not let another user publish", async () => {
    const l = await createDraft(deps, owner, input);
    const r = await publishListing(deps, other, l.id, false);
    expect(!r.ok && r.code).toBe("not_found");
  });
});

const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ sort: "newest", page: 1, pageSize: 12, ...over });

describe("searchPublished", () => {
  it("returns only published listings, filtered, newest first", async () => {
    const a = await createDraft(deps, owner, input);
    const b = await createDraft(deps, owner, { ...input, title: "Shop", useClass: "commercial", propertyType: "retail" });
    await createDraft(deps, owner, { ...input, title: "Unpublished" });
    for (const l of [a, b]) {
      const rec = await repo.get(l.id);
      await repo.save({ ...rec!, listing: { ...rec!.listing, status: "published" } });
    }
    expect((await searchPublished(deps, q())).items.map(l => l.title)).toEqual(["Shop", "Family home"]);
    expect((await searchPublished(deps, q({ useClass: "commercial" }))).items.map(l => l.title)).toEqual(["Shop"]);
    expect((await searchPublished(deps, q({ jurisdiction: "NSW" }))).items).toEqual([]);
  });
});

describe("rental bond pathway at publish", () => {
  const rent: DraftCreate = { ...input, transactionType: "rent", priceCents: 65_000 };

  async function readyRental(pathway?: "state_bond_authority" | "solicitor_trust") {
    const l = await createDraft(deps, owner, rent);
    const rec = (await repo.get(l.id))!;
    await repo.save({ ...rec, listingFeePaid: true, termsAccepted: true, ...(pathway ? { rentalBondPathway: pathway } : {}) });
    return l.id;
  }

  it("blocks a rental until the bond pathway is confirmed", async () => {
    const id = await readyRental();
    const r = await publishListing(deps, owner, id, true);
    expect(r.ok && r.value.decision.allowed).toBe(false);
  });

  it("allows a rental whose bond is held by a state bond authority (no trust account needed)", async () => {
    const id = await readyRental("state_bond_authority");
    const r = await publishListing(deps, owner, id, false);
    expect(r.ok && r.value.decision.allowed).toBe(true);
  });

  it("still requires an approved trust account when the bond goes to a solicitor's trust account", async () => {
    const id = await readyRental("solicitor_trust");
    const r = await publishListing(deps, owner, id, true);
    expect(r.ok && r.value.decision.allowed).toBe(false);
  });
});

describe("rental bond pathway on drafts", () => {
  it("accepts a known pathway in a patch and rejects an unknown one", () => {
    expect(parseDraftPatch({ rentalBondPathway: "solicitor_trust" })).toEqual({ ok: true, value: { rentalBondPathway: "solicitor_trust" } });
    expect(parseDraftPatch({ rentalBondPathway: "cash" }).ok).toBe(false);
  });

  it("stores the pathway on the record, not on the listing", async () => {
    const l = await createDraft(deps, owner, { ...input, transactionType: "rent" });
    const r = await updateDraft(deps, owner, l.id, { rentalBondPathway: "state_bond_authority" });
    expect(r.ok).toBe(true);
    const rec = await repo.get(l.id);
    expect(rec?.rentalBondPathway).toBe("state_bond_authority");
    expect("rentalBondPathway" in (rec?.listing ?? {})).toBe(false);
  });
});

describe("agent publishing with an appointment", () => {
  const agent: Actor = { userId: "agent-1", userType: "agent" };

  async function draftWithFee() {
    const l = await createDraft(deps, owner, input);
    const rec = (await repo.get(l.id))!;
    await repo.save({ ...rec, listingFeePaid: true, termsAccepted: true });
    return l.id;
  }

  it("refuses an agent with no appointment, as if the listing did not exist", async () => {
    const id = await draftWithFee();
    deps.appointmentFor = async () => undefined;
    const r = await publishListing(deps, agent, id, true);
    expect(r.ok).toBe(false);
  });

  it("refuses an agent whose appointment is only enquiries and offers", async () => {
    const id = await draftWithFee();
    deps.appointmentFor = async (listingId, agentUserId) => ({ listingId, agentUserId, scope: "enquiries_and_offers", revoked: false });
    const r = await publishListing(deps, agent, id, true);
    expect(r.ok).toBe(false);
  });

  it("blocks a full-scope agent until the agent's licence is verified (fails closed)", async () => {
    const id = await draftWithFee();
    deps.appointmentFor = async (listingId, agentUserId) => ({ listingId, agentUserId, scope: "full", revoked: false });
    const r = await publishListing(deps, agent, id, true);
    expect(r.ok && r.value.decision.allowed).toBe(false);
  });
});
