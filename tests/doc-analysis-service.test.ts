import { beforeEach, describe, expect, it } from "vitest";
import { createUnconfiguredStorage } from "../src/adapters/object-storage";
import type { AuditEvent } from "../src/domain/audit";
import { ANALYSES_PER_HOUR, analyseStoredDocument, compareDocuments, latestAnalysis, shareAnalysis, type AnalysisStore, type AnalystDeps, type StoredAnalysis } from "../src/domain/doc-analysis-service";
import type { Analysis } from "../src/domain/doc-analyst";
import { createInMemoryDocumentStore } from "../src/domain/document-service";
import type { DocumentKind, DocumentRecord, Visibility } from "../src/domain/documents";
import { createDraft, createInMemoryListingRepository, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import { extractText } from "../src/server/doc-extract";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: uid(1), userType: "owner" };
const stranger: Actor = { userId: uid(2), userType: "owner" };
const inspector: Actor = { userId: uid(3), userType: "agent" };
const other: Actor = { userId: uid(4), userType: "agent" };

const CONTRACT = "Contract of sale. The vendor sells to the purchaser. The purchase price is $700,000. The deposit is 10% payable on exchange. Settlement is 14 days after the date of contract. The purchaser waives the cooling-off period. Special conditions apply.";
const REPORT = "Building and pest inspection report. Active termite damage was found in the subfloor. Cost to treat is approximately $3,000. The roof is in good condition and the property is well maintained.";

let listingId: string, deps: ListingServiceDeps, audits: AuditEvent[], notified: { userId: string; link: string }[], store: ReturnType<typeof memStore>;
let files: Record<string, string>, n: number, d: AnalystDeps;

function memStore() {
  const rows: (StoredAnalysis & { by: string })[] = [];
  const shares: string[] = [];
  const s: AnalysisStore = {
    async latest(documentId, engine) { return [...rows].reverse().find(r => r.documentId === documentId && r.analysis.engine === engine); },
    async byId(id) { return rows.find(r => r.id === id); },
    async insert(a) { rows.push({ id: a.id, documentId: a.documentId, listingId: a.listingId, createdAt: "2026-11-05T00:00:00.000Z", analysis: a.analysis as Analysis, by: a.requestedBy }); },
    async countRecent(userId) { return rows.filter(r => r.by === userId).length; },
    async addShares(_id, _by, ids) { const added = ids.filter(u => !shares.includes(u)); shares.push(...added); return added; }
  };
  return { s, rows, shares };
}

const doc = (id: number, kind: DocumentKind, visibility: Visibility): DocumentRecord => ({ id: uid(id), listingId, ownerUserId: owner.userId, kind, uploadedBy: owner.userId, visibility, status: "active" });

beforeEach(async () => {
  n = 100; audits = []; notified = [];
  deps = {
    repo: createInMemoryListingRepository(), appendAudit: async e => { audits.push(e); }, now: () => "2026-11-05T00:00:00.000Z", newId: () => uid(++n), requiredDisclosures: () => []
  };
  listingId = (await createDraft(deps, owner, { title: "Home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house" })).id;
  const docs = [doc(10, "contract", "owner_only"), doc(11, "building_inspection", "parties"), doc(12, "photo", "parties"), doc(13, "contract", "owner_only")];
  files = { [uid(10)]: CONTRACT, [uid(11)]: REPORT, [uid(12)]: "x", [uid(13)]: "Contract of sale. The vendor and purchaser agree. The price is $650,000. The deposit is 10%. Settlement is 60 days after contract. A cooling-off period of 5 business days applies. Subject to finance approval." };
  const docStore = createInMemoryDocumentStore({
    documents: docs, files: Object.fromEntries(docs.map(x => [x.id, { storageKey: x.id, contentType: "text/plain" }])),
    assignments: [{ id: uid(50), listingId, ownerUserId: owner.userId, contractorUserId: inspector.userId, kind: "inspector", status: "approved" }]
  }).store;
  store = memStore();
  d = {
    deps, docs: docStore, store: store.s, storage: { configured: true, async put() {}, async get(k) { return new TextEncoder().encode(files[k] ?? ""); } },
    extract: async (b, ct) => { const r = await extractText(b, ct); return r.ok ? { ok: true, text: r.text } : r; },
    notify: async (userId, p) => { notified.push({ userId, link: p.link }); }
  };
});

describe("analyseStoredDocument", () => {
  it("reads a document the owner can see, stores it once, audits it and returns the stored reading next time", async () => {
    const a = await analyseStoredDocument(d, owner, uid(10));
    expect(a.ok && a.value.analysis.docClass).toBe("contract");
    expect(a.ok && a.value.cached).toBe(false);
    expect(audits.filter(x => x.eventType === "document.analysed")).toHaveLength(1);
    const again = await analyseStoredDocument(d, owner, uid(10));
    expect(again.ok && again.value.cached).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(notified).toEqual([]);
  });
  it("lets an assigned inspector read a parties document and tells the owner", async () => {
    const r = await analyseStoredDocument(d, inspector, uid(11));
    expect(r.ok && r.value.analysis.cost?.basis).toBe("stated");
    expect(notified).toEqual([{ userId: owner.userId, link: `/listings/${listingId}/documents` }]);
  });
  it("answers not_found, without reading storage, for a stranger, a signed-in outsider and an unrelated contractor", async () => {
    for (const who of [stranger, other]) for (const id of [10, 11]) {
      const r = await analyseStoredDocument(d, who, uid(id));
      expect(r).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await latestAnalysis(d, stranger, uid(10))).toMatchObject({ ok: false, code: "not_found" });
    expect(store.rows).toEqual([]);
  });
  it("refuses photos, unconfigured storage, unreadable files and over-limit users", async () => {
    expect(await analyseStoredDocument(d, owner, uid(12))).toMatchObject({ ok: false, code: "invalid" });
    expect(await analyseStoredDocument({ ...d, storage: createUnconfiguredStorage() }, owner, uid(10))).toMatchObject({ ok: false, code: "unavailable" });
    files[uid(10)] = "";
    expect(await analyseStoredDocument(d, owner, uid(10))).toMatchObject({ ok: false, code: "invalid" });
    for (let i = 0; i < ANALYSES_PER_HOUR; i++) store.rows.push({ id: uid(900 + i), documentId: uid(900 + i), listingId, createdAt: "", analysis: { engine: "old" } as Analysis, by: owner.userId });
    files[uid(10)] = CONTRACT;
    expect(await analyseStoredDocument(d, owner, uid(10))).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("compareDocuments", () => {
  it("compares two contracts the user can see and refuses when any is hidden or the count is wrong", async () => {
    const c = await compareDocuments(d, owner, [uid(10), uid(13)]);
    expect(c.ok && c.value.rows.find(r => r.label === "Price")?.values).toEqual(["$700,000", "$650,000"]);
    expect(c.ok && c.value.verdict).toMatch(/Contract 2/);
    expect(await compareDocuments(d, inspector, [uid(11), uid(10)])).toMatchObject({ ok: false, code: "not_found" });
    expect(await compareDocuments(d, owner, [uid(10)])).toMatchObject({ ok: false, code: "invalid" });
    expect(await compareDocuments(d, owner, [uid(10), uid(10)])).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("shareAnalysis", () => {
  it("lets the owner tell only people who can already see the document, and never widens access", async () => {
    const a = await analyseStoredDocument(d, owner, uid(11));
    const id = a.ok ? a.value.id : "";
    const r = await shareAnalysis(d, owner, id, [inspector.userId, other.userId, stranger.userId, owner.userId]);
    expect(r).toEqual({ ok: true, value: { notified: 1, skipped: 2 } });
    expect(notified.map(x => x.userId)).toEqual([inspector.userId]);
    expect(audits.some(x => x.eventType === "document.analysis_shared")).toBe(true);
    const owned = await analyseStoredDocument(d, owner, uid(10));
    const priv = await shareAnalysis(d, owner, owned.ok ? owned.value.id : "", [inspector.userId]);
    expect(priv).toEqual({ ok: true, value: { notified: 0, skipped: 1 } });
  });
  it("is owner only and validates the list", async () => {
    const a = await analyseStoredDocument(d, owner, uid(11));
    const id = a.ok ? a.value.id : "";
    expect(await shareAnalysis(d, inspector, id, [other.userId])).toMatchObject({ ok: false, code: "forbidden" });
    expect(await shareAnalysis(d, stranger, id, [other.userId])).toMatchObject({ ok: false, code: "not_found" });
    expect(await shareAnalysis(d, owner, id, [])).toMatchObject({ ok: false, code: "invalid" });
    expect(await shareAnalysis(d, owner, uid(999), [other.userId])).toMatchObject({ ok: false, code: "not_found" });
  });
});
