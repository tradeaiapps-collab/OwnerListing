import { beforeEach, describe, expect, it } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { AuditEvent } from "../src/domain/audit";
import { approveDiligence, createInMemoryDiligenceStore, generateDiligence, getDiligence, saveDiligenceNote } from "../src/domain/elena-diligence-service";
import type { DocTextPort, ElenaPorts } from "../src/domain/elena-projects-service";
import { createInMemoryInvestmentRepository, createProject, decideProject, type InvestmentDeps } from "../src/domain/investment-service";
import { DEFAULT_POSTING } from "../src/domain/investment-terms";
import { moduleState } from "../src/domain/investor-projects";
import type { Actor } from "../src/domain/listing-service";
import { createInMemoryProjectDocStore, uploadProjectDocument, type ProjectDocInput } from "../src/domain/project-documents";
import type { StaffActor } from "../src/domain/staff-access";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const investor: Actor = { userId: U(2), userType: "buyer" };
const other: Actor = { userId: U(3), userType: "buyer" };
const unverified: Actor = { userId: U(4), userType: "buyer" };
const stranger: Actor = { userId: U(5), userType: "owner" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const fields = {
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "planning",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA lodged; build 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, visibleTo: "all_verified"
};
const PDF = (tag: string) => Uint8Array.from(Buffer.from(`%PDF-1.4\n${tag}\n%%EOF`));

let deps: InvestmentDeps, mem: ReturnType<typeof createInMemoryInvestmentRepository>, docs: ReturnType<typeof createInMemoryProjectDocStore>;
let store: ReturnType<typeof createInMemoryDiligenceStore>, ports: ElenaPorts, objects: Map<string, Uint8Array>, audit: AuditEvent[], notices: { to: string; template: string; text: string }[];
let hits = 1, clock = "2026-11-20T00:00:00.000Z", n = 0;
/** What each stored file "reads" as, by the tag inside the fake PDF. */
const pagesByTag: Record<string, string[]> = {};
const text: DocTextPort = { async pages(bytes) { const tag = Buffer.from(bytes).toString().split("\n")[1] ?? ""; return pagesByTag[tag] ?? []; } };

beforeEach(async () => {
  n = 0; hits = 1; clock = "2026-11-20T00:00:00.000Z"; audit = []; notices = []; objects = new Map();
  for (const k of Object.keys(pagesByTag)) delete pagesByTag[k];
  mem = createInMemoryInvestmentRepository(); docs = createInMemoryProjectDocStore(); store = createInMemoryDiligenceStore();
  const storage = { configured: true, async put(k: string, b: Uint8Array) { objects.set(k, b); }, async get(k: string) { const b = objects.get(k); if (!b) throw new Error("missing"); return b; } };
  ports = { storage, text };
  deps = {
    repo: mem.repo, moduleState: async () => moduleState(true, true), postingSettings: async () => ({ ...DEFAULT_POSTING }),
    verification: async u => ({ emailVerified: true, phoneVerified: u !== unverified.userId, idVerified: true }), countHit: async () => hits, contactFor: async () => undefined,
    notify: async (to, template, _s, t) => { notices.push({ to, template, text: t }); },
    files: { storage, scanner: { configured: true, async scan() { return "clean" as const; } } },
    startUpfrontCheckout: async () => { throw new Error("no"); }, sha256: async () => "a".repeat(64), appUrl: "http://test",
    appendAudit: async e => { audit.push(e); }, now: () => clock, newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  for (const [i, a] of [[200, investor], [201, other]] as const) await mem.repo.addDeclaration({ id: U(i), userId: a.userId, category: "retail", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: clock });
});

async function approvedProject() {
  const r = await createProject(deps, owner, fields);
  if (!r.ok) throw new Error(r.message);
  const p = (await mem.repo.getProject(r.value.project.id))!;
  expect((await decideProject(deps, admin, p.id, "approve", "Checked issuer and risks.", p.version)).ok).toBe(true);
  return p.id;
}
async function addDoc(projectId: string, tag: string, pages: string[], o: Partial<ProjectDocInput> & { confirm?: boolean; terms?: string[] } = {}) {
  pagesByTag[tag] = pages;
  const { confirm = true, terms = [], ...rest } = o;
  const r = await uploadProjectDocument(deps, docs.store, deps.files, owner, projectId, { kind: "feasibility", visibility: "investors", title: tag, declaredMime: "application/pdf", bytes: PDF(tag), ...rest });
  if (!r.ok) throw new Error(r.message);
  if (confirm) await docs.store.addMask({ id: `88888888-8888-4888-8888-${String(++n).padStart(12, "0")}`, documentId: r.value.id, revision: 1, boxes: [], terms, pageCount: pages.length, textFound: true, confirmed: true, actorId: admin.id, createdAt: clock });
  return r.value.id;
}

const gen = (who: Actor = owner, id = pid) => generateDiligence(deps, store, docs.store, ports, who, id);
let pid = "";

describe("Elena due-diligence service", () => {
  beforeEach(async () => { pid = await approvedProject(); });

  it("the owner gets a private draft that investors cannot see until it is approved", async () => {
    await addDoc(pid, "feas", ["The total project cost is $4,200,000. Approval is subject to a flood study."], { kind: "feasibility" });
    const g = await gen();
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.status).toBe("draft");
    expect(g.value.summary.risks.length).toBeGreaterThan(0);
    expect(g.value.notice).toMatch(/not financial advice/);
    const inv = await getDiligence(deps, store, docs.store, investor, pid);
    expect(inv.ok && inv.value.role === "investor" && inv.value.published === undefined && inv.value.draft === undefined).toBe(true);
    expect((await approveDiligence(deps, store, investor, pid, g.value.id)).ok).toBe(false);
    expect((await approveDiligence(deps, store, owner, pid, g.value.id)).ok).toBe(true);
    const after = await getDiligence(deps, store, docs.store, investor, pid);
    expect(after.ok && after.value.published?.status).toBe("published");
    expect(audit.map(a => a.eventType)).toEqual(expect.arrayContaining(["investment.diligence_drafted", "investment.diligence_published"]));
  });

  it("regenerating rewrites the one draft and keeps the developer's note; a published summary cannot change", async () => {
    await addDoc(pid, "feas", ["The total project cost is $4,200,000."]);
    const g1 = await gen();
    if (!g1.ok) throw new Error(g1.message);
    expect((await saveDiligenceNote(deps, store, owner, pid, g1.value.id, "Costs include GST.")).ok).toBe(true);
    const g2 = await gen();
    if (!g2.ok) throw new Error(g2.message);
    expect(g2.value.id).toBe(g1.value.id);
    expect(g2.value.developerNote).toBe("Costs include GST.");
    expect(store.rows).toHaveLength(1);
    await approveDiligence(deps, store, owner, pid, g1.value.id);
    expect((await approveDiligence(deps, store, owner, pid, g1.value.id)).ok).toBe(false);
    expect((await saveDiligenceNote(deps, store, owner, pid, g1.value.id, "Changed")).ok).toBe(false);
    const g3 = await gen();
    expect(g3.ok && g3.value.id !== g1.value.id).toBe(true);
    const inv = await getDiligence(deps, store, docs.store, investor, pid);
    expect(inv.ok && inv.value.published?.id).toBe(g1.value.id);
  });

  it("only reads documents with a confirmed mask, and never leaks the masked address to investors", async () => {
    await addDoc(pid, "ok", ["Approval is subject to conditions. The site at 12 Smith Street, Bulimba has a flood overlay."], { kind: "approval", terms: ["Smith Street"] });
    await addDoc(pid, "wait", ["Secret unconfirmed contract text about a dispute."], { kind: "contract", confirm: false });
    await addDoc(pid, "priv", ["Private note about litigation."], { kind: "other", visibility: "private" });
    const g = await gen();
    if (!g.ok) throw new Error(g.message);
    const s = JSON.stringify(g.value.summary);
    expect(s).not.toMatch(/Smith|Secret|litigation|dispute/);
    expect(g.value.summary.notRead.some(n => n.id.startsWith("pending-"))).toBe(true);
    await approveDiligence(deps, store, owner, pid, g.value.id);
    const inv = await getDiligence(deps, store, docs.store, investor, pid);
    expect(inv.ok && JSON.stringify(inv.value)).not.toMatch(/Smith|Secret|litigation|dispute|12 /);
  });

  it("reports when the documents changed after the summary was approved", async () => {
    await addDoc(pid, "doc-a", ["The total project cost is $4,200,000."]);
    const g = await gen();
    if (!g.ok) throw new Error(g.message);
    await approveDiligence(deps, store, owner, pid, g.value.id);
    expect((await getDiligence(deps, store, docs.store, investor, pid)) .ok).toBe(true);
    const before = await getDiligence(deps, store, docs.store, investor, pid);
    expect(before.ok && before.value.published?.outdated).toBe(false);
    await addDoc(pid, "doc-b", ["A progress report with new figures for the project."], { kind: "report" });
    const after = await getDiligence(deps, store, docs.store, investor, pid);
    expect(after.ok && after.value.published?.outdated).toBe(true);
  });

  it("is owner-only to write, and not found for outsiders and staff; unverified investors cannot read", async () => {
    expect((await gen(investor)).ok).toBe(false);
    expect((await gen(stranger)).ok).toBe(false);
    const r = await getDiligence(deps, store, docs.store, stranger, pid);
    expect(r.ok).toBe(false);
    const u = await getDiligence(deps, store, docs.store, unverified, pid);
    expect(u.ok).toBe(false);
  });

  it("will not publish before staff approve the project, and rate limits drafts", async () => {
    const r = await createProject(deps, owner, { ...fields, title: "Second project" });
    if (!r.ok) throw new Error(r.message);
    const g = await gen(owner, r.value.project.id);
    if (!g.ok) throw new Error(g.message);
    const a = await approveDiligence(deps, store, owner, r.value.project.id, g.value.id);
    expect(a.ok).toBe(false);
    hits = 7;
    const limited = await gen();
    expect(!limited.ok && limited.code).toBe("rate_limited");
  });

  it("a scan with no text is listed as not covered, never guessed at", async () => {
    await addDoc(pid, "scan", [], { kind: "plan" });
    const g = await gen();
    if (!g.ok) throw new Error(g.message);
    expect(g.value.summary.notRead.map(n => n.id).some(i => i.startsWith("unread-"))).toBe(true);
  });
});
