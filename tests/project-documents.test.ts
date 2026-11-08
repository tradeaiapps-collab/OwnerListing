import { beforeEach, describe, expect, it } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { MalwareScanPort } from "../src/adapters/malware-scan";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import type { AuditEvent } from "../src/domain/audit";
import { createInMemoryInvestmentRepository, createProject, decideProject, type InvestmentDeps } from "../src/domain/investment-service";
import { DEFAULT_POSTING } from "../src/domain/investment-terms";
import { moduleState } from "../src/domain/investor-projects";
import type { Actor } from "../src/domain/listing-service";
import {
  createInMemoryProjectDocStore, listProjectDocuments, readProjectDocument, uploadProjectDocument, type ProjectDocInput
} from "../src/domain/project-documents";
import type { StaffActor } from "../src/domain/staff-access";
import { jpeg } from "./helpers/image-fixtures";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const wholesale: Actor = { userId: U(2), userType: "buyer" };
const retail: Actor = { userId: U(3), userType: "buyer" };
const stranger: Actor = { userId: U(5), userType: "owner" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);

const fields = (o: Record<string, unknown> = {}) => ({
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "planning",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA lodged; build 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, visibleTo: "all_verified", ...o
});

let deps: InvestmentDeps;
let mem: ReturnType<typeof createInMemoryInvestmentRepository>;
let docs: ReturnType<typeof createInMemoryProjectDocStore>;
let objects: Map<string, Uint8Array>;
let ports: { storage: ObjectStoragePort; scanner: MalwareScanPort };
let verdict: "clean" | "infected";
let audit: AuditEvent[];
let n = 0;

beforeEach(async () => {
  n = 0; verdict = "clean"; audit = []; objects = new Map();
  mem = createInMemoryInvestmentRepository();
  docs = createInMemoryProjectDocStore();
  ports = {
    storage: { configured: true, async put(k, b) { objects.set(k, b); }, async get(k) { const b = objects.get(k); if (!b) throw new Error("missing"); return b; } },
    scanner: { configured: true, async scan() { return verdict; } }
  };
  deps = {
    repo: mem.repo,
    moduleState: async () => moduleState(true, true),
    postingSettings: async () => ({ ...DEFAULT_POSTING }),
    verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }),
    countHit: async () => 1,
    contactFor: async () => undefined,
    notify: async () => {},
    files: { storage: ports.storage, scanner: ports.scanner },
    startUpfrontCheckout: async () => { throw new Error("not connected"); },
    sha256: async () => "a".repeat(64),
    appUrl: "http://test",
    appendAudit: async e => { audit.push(e); },
    now: () => "2026-10-28T00:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  await mem.repo.addDeclaration({ id: U(200), userId: wholesale.userId, category: "wholesale", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-10-28T00:00:00.000Z" });
  await mem.repo.addDeclaration({ id: U(201), userId: retail.userId, category: "retail", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-10-28T00:00:00.000Z" });
});

const PDF = (tag = "a") => Uint8Array.from(Buffer.from(`%PDF-1.4\n${tag}\n%%EOF`));
async function posted() {
  const r = await createProject(deps, owner, fields());
  if (!r.ok) throw new Error(r.message);
  return r.value.project.id;
}
async function approve(id: string) {
  const p = (await mem.repo.getProject(id))!;
  expect((await decideProject(deps, admin, id, "approve", "Checked issuer and risks.", p.version)).ok).toBe(true);
}
const add = (id: string, o: Partial<ProjectDocInput> = {}, who: Actor = owner) =>
  uploadProjectDocument(deps, docs.store, ports, who, id, { kind: "feasibility", visibility: "investors", title: "Feasibility study", declaredMime: "application/pdf", bytes: PDF(), ...o });
const titles = async (id: string, who: Actor | null, staff?: { staffId: string }) => {
  const r = await listProjectDocuments(deps, docs.store, who, id, staff);
  return r.ok ? r.value.documents.map(d => d.title) : r.code;
};

/** Staff confirm the address masking of a document (investors see a document only after that). */
const confirmMask = async (title: string) => {
  const d = docs.rows.find(r => r.record.title === title)!.record;
  const prev = await docs.store.latestMask(d.id);
  await docs.store.addMask({ id: `88888888-8888-4888-8888-${String(++n).padStart(12, "0")}`, documentId: d.id, revision: (prev?.revision ?? 0) + 1, boxes: [], terms: [], pageCount: 1, textFound: true, confirmed: true, actorId: admin.id, createdAt: "2026-10-28T00:00:00.000Z" });
};

describe("project document upload", () => {
  it("stores the file under a random three-segment key and writes an audit event", async () => {
    const id = await posted();
    const r = await add(id);
    expect(r.ok).toBe(true);
    const key = [...objects.keys()][0]!;
    expect(key).toMatch(new RegExp(`^investments/${id}/[0-9a-f-]{36}$`));
    expect(docs.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.some(e => e.eventType === "investment.project_document_uploaded")).toBe(true);
  });

  it("only the owner may upload", async () => {
    const id = await posted();
    const r = await add(id, {}, stranger);
    expect(!r.ok && r.code).toBe("not_found");
    expect(objects.size).toBe(0);
  });

  it("refuses unknown kinds, visibilities, bad titles, wrong or disguised types, empty and infected files", async () => {
    const id = await posted();
    for (const o of [{ kind: "nope" }, { visibility: "public" }, { title: " " }, { title: "Call me on 0412 345 678" }, { title: "mail bob@example.com" }, { declaredMime: "application/zip" }, { declaredMime: "image/png" }, { bytes: EXE, declaredMime: "application/pdf" }, { bytes: new Uint8Array() }]) {
      expect((await add(id, o)).ok).toBe(false);
    }
    verdict = "infected";
    expect((await add(id)).ok).toBe(false);
    expect(objects.size).toBe(0);
    expect(docs.rows).toHaveLength(0);
  });

  it("fails closed while storage or the scanner is not configured, and for a rejected project", async () => {
    const id = await posted();
    ports = { ...ports, storage: { ...ports.storage, configured: false } };
    const r = await add(id);
    expect(!r.ok && r.code).toBe("unavailable");
    ports = { ...ports, storage: { ...ports.storage, configured: true } };
    const p = (await mem.repo.getProject(id))!;
    await decideProject(deps, admin, id, "reject", "Not a real project offer.", p.version);
    const closed = await add(id);
    expect(!closed.ok && closed.code).toBe("conflict");
  });

  it("a replacement keeps the earlier version on record; only the current version can be replaced", async () => {
    const id = await posted();
    const a = await add(id), first = a.ok ? a.value.id : "";
    const b = await add(id, { bytes: PDF("v2"), supersedesId: first });
    expect(b.ok).toBe(true);
    expect(docs.rows).toHaveLength(2);
    const again = await add(id, { bytes: PDF("v3"), supersedesId: first });
    expect(!again.ok && again.code).toBe("conflict");
    const mine = await listProjectDocuments(deps, docs.store, owner, id);
    expect(mine.ok && mine.value.documents.map(d => d.current)).toEqual([true, false]);
    const kindChange = await add(id, { kind: "plan", supersedesId: b.ok ? b.value.id : "" });
    expect(!kindChange.ok && kindChange.code).toBe("invalid");
  });
});

describe("who sees project documents", () => {
  async function setup() {
    const id = await posted();
    await approve(id);
    await add(id, { title: "Private note", visibility: "private" });
    await add(id, { title: "Team plan", visibility: "team", kind: "plan" });
    await add(id, { title: "Investor feasibility", visibility: "investors" });
    return id;
  }

  it("owner sees all, reviewing staff see team and investor documents, an eligible investor sees investor documents only", async () => {
    const id = await setup();
    expect(await titles(id, owner)).toEqual(expect.arrayContaining(["Private note", "Team plan", "Investor feasibility"]));
    expect(await titles(id, null, { staffId: admin.id })).toEqual(expect.arrayContaining(["Team plan", "Investor feasibility"]));
    expect(await titles(id, null, { staffId: admin.id })).not.toContain("Private note");
    expect(await titles(id, wholesale)).toEqual([]);
    await confirmMask("Investor feasibility");
    expect(await titles(id, wholesale)).toEqual(["Investor feasibility"]);
    expect(await titles(id, owner)).toContain("Investor feasibility");
  });

  it("an investor sees nothing while the masking is unconfirmed, and again after a later unconfirmed revision", async () => {
    const id = await setup();
    await confirmMask("Investor feasibility");
    const d = docs.rows.find(r => r.record.title === "Investor feasibility")!.record;
    await docs.store.addMask({ id: U(777), documentId: d.id, revision: 2, boxes: [], terms: [], pageCount: 1, textFound: true, confirmed: false, actorId: admin.id, createdAt: "2026-10-28T00:00:00.000Z" });
    expect(await titles(id, wholesale)).toEqual([]);
    const staffList = await listProjectDocuments(deps, docs.store, null, id, { staffId: admin.id });
    expect(staffList.ok && staffList.value.documents.find(x => x.title === "Investor feasibility")!.masking).toBe("pending");
  });

  it("strangers, signed-out visitors and investors of a project awaiting review get not_found", async () => {
    const id = await setup();
    expect(await titles(id, stranger)).toBe("not_found");
    expect(await titles(id, null)).toBe("not_found");
    const pending = await posted();
    await add(pending);
    expect(await titles(pending, wholesale)).toBe("not_found");
  });

  it("file bytes follow the same rules, and staff views are logged", async () => {
    const id = await setup();
    const all = docs.rows.map(r => r.record);
    const byTitle = (t: string) => all.find(d => d.title === t)!.id;
    const read = (who: Actor | null, doc: string, staff?: { staffId: string }) => readProjectDocument(deps, docs.store, ports.storage, who, doc, staff);
    // Investors never receive the original file; they read masked page images instead.
    await confirmMask("Investor feasibility");
    const raw = await read(wholesale, byTitle("Investor feasibility"));
    expect(!raw.ok && raw.code).toBe("not_found");
    const hidden = await read(wholesale, byTitle("Team plan"));
    expect(!hidden.ok && hidden.code).toBe("not_found");
    expect((await read(null, byTitle("Team plan"), { staffId: admin.id })).ok).toBe(true);
    expect(audit.some(e => e.eventType === "investment.project_document_viewed_by_staff")).toBe(true);
    const priv = await read(null, byTitle("Private note"), { staffId: admin.id });
    expect(!priv.ok && priv.code).toBe("not_found");
    expect((await read(owner, byTitle("Private note"))).ok).toBe(true);
  });

  it("an investor and staff no longer get a replaced version; the owner still does", async () => {
    const id = await setup();
    const old = docs.rows.find(r => r.record.title === "Investor feasibility")!.record.id;
    await add(id, { title: "Investor feasibility v2", bytes: PDF("v2"), supersedesId: old });
    await confirmMask("Investor feasibility v2");
    expect(await titles(id, wholesale)).toEqual(["Investor feasibility v2"]);
    const r = await readProjectDocument(deps, docs.store, ports.storage, wholesale, old);
    expect(!r.ok && r.code).toBe("not_found");
    expect((await readProjectDocument(deps, docs.store, ports.storage, owner, old)).ok).toBe(true);
  });
});
