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
  createInMemoryProjectDocStore, uploadProjectDocument, type ProjectDocInput
} from "../src/domain/project-documents";
import { createInMemoryDocViewStore, listDocumentViews, recordDocumentView, versionNumbers, VIEW_DEDUPE_MS } from "../src/domain/project-document-views";
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
let clock = Date.parse("2026-10-28T00:00:00.000Z");
let views: ReturnType<typeof createInMemoryDocViewStore>;

beforeEach(async () => {
  n = 0; clock = Date.parse("2026-10-28T00:00:00.000Z"); views = createInMemoryDocViewStore({ [U(2)]: "Wendy Wholesale", [U(3)]: "Ray Retail" }); verdict = "clean"; audit = []; objects = new Map();
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
    now: () => new Date(clock).toISOString(),
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
describe("document room: versions and view log", () => {
  it("numbers versions along the replacement chain", async () => {
    const id = await posted();
    const a = await add(id); const b = await add(id, { supersedesId: a.ok ? a.value.id : "" });
    const c = await add(id, { supersedesId: b.ok ? b.value.id : "" });
    const v = versionNumbers(docs.rows.map(r => r.record));
    expect([a, b, c].map(r => (r.ok ? v.get(r.value.id) : 0))).toEqual([1, 2, 3]);
  });

  it("logs an investor opening a document, once per 10 minutes, and shows it to the owner only", async () => {
    const id = await posted(); await approve(id);
    const up = await add(id); const docId = up.ok ? up.value.id : "";
    await recordDocumentView(deps, docs.store, views.store, wholesale, docId);
    await recordDocumentView(deps, docs.store, views.store, wholesale, docId);
    expect(views.rows).toHaveLength(1);
    clock += VIEW_DEDUPE_MS + 1000;
    await recordDocumentView(deps, docs.store, views.store, wholesale, docId);
    await recordDocumentView(deps, docs.store, views.store, retail, docId);
    const r = await listDocumentViews(deps, docs.store, views.store, owner, id);
    expect(r.ok && r.value.views.map(v => [v.investorName, v.opens, v.version])).toEqual(expect.arrayContaining([["Wendy Wholesale", 2, 1], ["Ray Retail", 1, 1]]));
    expect(r.ok && r.value.views).toHaveLength(2);
    for (const who of [wholesale, stranger]) expect((await listDocumentViews(deps, docs.store, views.store, who, id))).toMatchObject({ ok: false, code: "not_found" });
  });

  it("does not log the owner, a stranger, or an investor who may not see the project; a failing store never throws", async () => {
    const id = await posted(); await approve(id);
    const up = await add(id, { visibility: "team" }); const docId = up.ok ? up.value.id : "";
    await recordDocumentView(deps, docs.store, views.store, owner, docId);
    await recordDocumentView(deps, docs.store, views.store, stranger, docId);
    await recordDocumentView(deps, docs.store, views.store, wholesale, "00000000-0000-4000-8000-000000000999");
    expect(views.rows).toHaveLength(0);
    const broken = { async addView() { throw new Error("db down"); }, async viewsFor() { return []; } };
    await expect(recordDocumentView(deps, docs.store, broken, wholesale, docId)).resolves.toBeUndefined();
  });
});
