import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { QLD_DRAFT_VERSIONS, SEED_NOTE, getRequiredDisclosureKeys } from "../src/config/disclosures";
import {
  approvalBlocker, buildChecklist, itemsFor, parseItems, parseNewVersion, parseSubmission, requiredKeys, type DisclosureItem, type DisclosureRecord
} from "../src/domain/disclosure-config";
import {
  createDraft, createInMemoryListingRepository, publishListing, type Actor, type ListingServiceDeps
} from "../src/domain/listing-service";

const item = (o: Partial<DisclosureItem> = {}): DisclosureItem => ({
  key: "qld_test_item", label: "Test item", description: "Something the owner must provide.", legalRef: "Test Act 2026 (Qld)",
  notApplicableAllowed: false, ...o
});

describe("parseItems", () => {
  it("accepts valid items and de-duplicates property types", () => {
    const r = parseItems([{ ...item(), propertyTypes: ["unit", "unit", "house"] }, item({ key: "qld_other" })]);
    expect(r).toEqual({ ok: true, value: [{ ...item(), propertyTypes: ["unit", "house"] }, item({ key: "qld_other" })] });
  });
  it("rejects bad keys, duplicates, missing text, unknown types and too many items", () => {
    expect(parseItems("x").ok).toBe(false);
    expect(parseItems([item({ key: "Bad Key" })]).ok).toBe(false);
    expect(parseItems([item(), item()])).toMatchObject({ ok: false, message: expect.stringMatching(/used twice/) });
    expect(parseItems([item({ description: "short" })]).ok).toBe(false);
    expect(parseItems([{ ...item(), notApplicableAllowed: "yes" }]).ok).toBe(false);
    expect(parseItems([{ ...item(), propertyTypes: ["castle"] }]).ok).toBe(false);
    expect(parseItems([{ ...item(), propertyTypes: [] }]).ok).toBe(false);
    expect(parseItems(Array.from({ length: 41 }, (_, i) => item({ key: `qld_item_${i}` }))).ok).toBe(false);
  });
  it("allows an empty list (a combination that needs no disclosures)", () => {
    expect(parseItems([])).toEqual({ ok: true, value: [] });
  });
});

describe("parseNewVersion", () => {
  const ok = { jurisdiction: "QLD", transactionType: "sale", useClass: "residential", items: [item()], note: "From counsel advice of 1 Nov." };
  it("accepts a complete draft", () => {
    expect(parseNewVersion(ok)).toEqual({ ok: true, value: { ...ok, items: [item()] } });
  });
  it("rejects unknown combos and a missing note", () => {
    expect(parseNewVersion({ ...ok, jurisdiction: "XX" }).ok).toBe(false);
    expect(parseNewVersion({ ...ok, transactionType: "lease" }).ok).toBe(false);
    expect(parseNewVersion({ ...ok, useClass: "rural" }).ok).toBe(false);
    expect(parseNewVersion({ ...ok, note: "short" }).ok).toBe(false);
    expect(parseNewVersion(null).ok).toBe(false);
  });
});

describe("checklist and requirements per property type", () => {
  const items = [item({ key: "qld_all" }), item({ key: "qld_units", propertyTypes: ["unit", "townhouse"], notApplicableAllowed: true })];
  it("applies items by property type", () => {
    expect(requiredKeys(items, "house")).toEqual(["qld_all"]);
    expect(requiredKeys(items, "unit")).toEqual(["qld_all", "qld_units"]);
    expect(itemsFor(items, "land").map(i => i.key)).toEqual(["qld_all"]);
  });
  it("shows each item's state from the stored rows, ignoring other states and keys no longer required", () => {
    const rows: DisclosureRecord[] = [
      { key: "qld_units", jurisdiction: "QLD", satisfied: false, state: "rejected", notApplicable: true, evidenceDocumentId: null, reviewReason: "There is a body corporate." },
      { key: "qld_all", jurisdiction: "NSW", satisfied: true, state: "verified", notApplicable: false, evidenceDocumentId: "d1", reviewReason: null },
      { key: "qld_old", jurisdiction: "QLD", satisfied: true, state: "verified", notApplicable: false, evidenceDocumentId: "d2", reviewReason: null }
    ];
    expect(buildChecklist(items, "unit", "QLD", rows).map(c => [c.key, c.state, c.reviewReason])).toEqual([
      ["qld_all", "missing", null], ["qld_units", "rejected", "There is a body corporate."]
    ]);
  });
});

describe("parseSubmission", () => {
  const doc = "00000000-0000-4000-8000-000000000001";
  it("takes an evidence document id", () => {
    expect(parseSubmission({ evidenceDocumentId: doc }, item())).toEqual({ ok: true, value: { kind: "evidence", documentId: doc } });
    expect(parseSubmission({ evidenceDocumentId: "nope" }, item()).ok).toBe(false);
  });
  it("allows not applicable only where the item allows it, with a reason", () => {
    expect(parseSubmission({ notApplicable: true, note: "No pool here." }, item()).ok).toBe(false);
    expect(parseSubmission({ notApplicable: true, note: "No pool here." }, item({ notApplicableAllowed: true })))
      .toEqual({ ok: true, value: { kind: "not_applicable", note: "No pool here." } });
    expect(parseSubmission({ notApplicable: true, note: "no" }, item({ notApplicableAllowed: true })).ok).toBe(false);
  });
});

describe("approvalBlocker", () => {
  it("needs a draft and someone other than the author", () => {
    expect(approvalBlocker({ status: "draft", createdBy: "a" }, "b")).toBeUndefined();
    expect(approvalBlocker({ status: "draft", createdBy: null }, "b")).toBeUndefined();
    expect(approvalBlocker({ status: "draft", createdBy: "a" }, "a")).toMatch(/other than the author/);
    expect(approvalBlocker({ status: "approved", createdBy: "a" }, "b")).toMatch(/Only a draft/);
  });
});

describe("Queensland seed", () => {
  it("is valid, covers the four QLD combinations, and the code fallback stays closed", () => {
    expect(QLD_DRAFT_VERSIONS.map(v => `${v.transactionType}:${v.useClass}`).sort()).toEqual(["rent:commercial", "rent:residential", "sale:commercial", "sale:residential"]);
    for (const v of QLD_DRAFT_VERSIONS) expect(parseItems(v.items)).toEqual({ ok: true, value: v.items });
    expect(requiredKeys(QLD_DRAFT_VERSIONS[0]!.items, "house")).toContain("qld_seller_disclosure_statement");
    expect(requiredKeys(QLD_DRAFT_VERSIONS[3]!.items, "office")).toEqual([]);
    expect(requiredKeys(QLD_DRAFT_VERSIONS[3]!.items, "retail")).toEqual(["qld_retail_lessor_disclosure"]);
    expect(getRequiredDisclosureKeys("QLD", "sale", "residential")).toBeNull();
  });

  it("matches the migration exactly, and the migration seeds drafts only", () => {
    const sql = readFileSync("db/20261025200000_state_disclosures.sql", "utf8");
    const seed = sql.slice(sql.indexOf("INSERT INTO disclosure_config_version"));
    const rows = [...seed.matchAll(/\('QLD', '(sale|rent)', '(residential|commercial)', 1, '((?:[^']|'')*)'::jsonb, '(\w+)', '((?:[^']|'')*)'\)/g)];
    expect(rows).toHaveLength(4);
    for (const [, tx, use, json, status, note] of rows) {
      const v = QLD_DRAFT_VERSIONS.find(x => x.transactionType === tx && x.useClass === use)!;
      expect(JSON.parse(json!.replace(/''/g, "'"))).toEqual(JSON.parse(JSON.stringify(v.items)));
      expect(status).toBe("draft");
      expect(note!.replace(/''/g, "'")).toBe(SEED_NOTE);
    }
  });
});

describe("publish gate with versioned requirements", () => {
  const owner: Actor = { userId: "owner-1", userType: "owner" };
  let n = 0;
  let deps: ListingServiceDeps;
  let marked: [string, string][];
  beforeEach(() => {
    n = 0; marked = [];
    deps = {
      repo: createInMemoryListingRepository(), appendAudit: async () => {}, now: () => "2026-10-25T00:00:00.000Z", newId: () => `id-${++n}`,
      requiredDisclosures: () => [], trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }),
      disclosureRequirements: async () => ({ versionId: "v1", keys: ["qld_seller_disclosure_statement"] }),
      markDisclosureVersion: async (l, v) => { marked.push([l, v]); }
    };
  });
  const ready = async (satisfied: boolean) => {
    const l = await createDraft(deps, owner, { title: "Home", address: "1 St", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house", priceCents: 85_000_000 });
    const rec = (await deps.repo.get(l.id))!;
    await deps.repo.save({ ...rec, listingFeePaid: true, termsAccepted: true,
      listing: { ...rec.listing, disclosures: [{ key: "qld_seller_disclosure_statement", jurisdiction: "QLD", satisfied }] } });
    return l;
  };

  it("blocks until the required item is verified, then publishes and records the version passed", async () => {
    const pending = await ready(false);
    const r = await publishListing(deps, owner, pending.id, false);
    expect(r.ok && r.value.decision.reasons).toEqual(["Required disclosure is incomplete: qld_seller_disclosure_statement."]);
    expect(marked).toEqual([]);
    const done = await ready(true);
    const p = await publishListing(deps, owner, done.id, false);
    expect(p.ok && p.value.listing.status).toBe("published");
    expect(marked).toEqual([[done.id, "v1"]]);
  });

  it("blocks when no version is approved for the combination, even if the old code config would allow it", async () => {
    deps.disclosureRequirements = async () => null;
    const l = await ready(true);
    const r = await publishListing(deps, owner, l.id, true);
    expect(r.ok && r.value.decision.reasons).toEqual([expect.stringMatching(/No compliance-approved disclosure configuration for QLD sale/)]);
  });

  it("blocks when the requirements cannot be read (fails closed)", async () => {
    deps.disclosureRequirements = async () => { throw new Error("db down"); };
    const l = await ready(true);
    const r = await publishListing(deps, owner, l.id, true);
    expect(r.ok && r.value.decision.allowed).toBe(false);
  });

  it("does not record a version on a dry run", async () => {
    const l = await ready(true);
    const r = await publishListing(deps, owner, l.id, true);
    expect(r.ok && r.value.decision.allowed).toBe(true);
    expect(marked).toEqual([]);
  });
});
