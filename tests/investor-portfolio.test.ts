import { beforeEach, describe, expect, it } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import { createInMemoryElenaStore, type ElenaProjectStore } from "../src/domain/elena-projects-service";
import { createInMemoryInvestmentRepository, createProject, decideProject, expressInterest, type InvestmentDeps } from "../src/domain/investment-service";
import { DEFAULT_POSTING } from "../src/domain/investment-terms";
import { attentionFor, buildPortfolio } from "../src/domain/investor-portfolio";
import { moduleState } from "../src/domain/investor-projects";
import type { Actor } from "../src/domain/listing-service";
import { createInMemoryProjectDocStore } from "../src/domain/project-documents";
import type { StaffActor } from "../src/domain/staff-access";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const investor: Actor = { userId: U(2), userType: "buyer" };
const other: Actor = { userId: U(3), userType: "buyer" };
const wholesaleOnly: Actor = { userId: U(4), userType: "buyer" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const fields = {
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "planning",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA lodged; build 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, visibleTo: "all_verified"
};

let deps: InvestmentDeps, mem: ReturnType<typeof createInMemoryInvestmentRepository>, docs: ReturnType<typeof createInMemoryProjectDocStore>, elena: ReturnType<typeof createInMemoryElenaStore>;
let clock = "2026-11-21T00:00:00.000Z", n = 0;
const id = () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`;

beforeEach(async () => {
  n = 0; clock = "2026-11-21T00:00:00.000Z";
  mem = createInMemoryInvestmentRepository(); docs = createInMemoryProjectDocStore(); elena = createInMemoryElenaStore();
  const storage = { configured: true, async put() {}, async get() { return new Uint8Array(); } };
  deps = {
    repo: mem.repo, moduleState: async () => moduleState(true, true), postingSettings: async () => ({ ...DEFAULT_POSTING }),
    verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }), countHit: async () => 1, contactFor: async () => undefined,
    notify: async () => {}, files: { storage, scanner: { configured: true, async scan() { return "clean" as const; } } },
    startUpfrontCheckout: async () => { throw new Error("no"); }, sha256: async () => "a".repeat(64), appUrl: "http://test",
    appendAudit: async () => {}, now: () => clock, newId: id
  };
  let d = 200;
  for (const [a, cat] of [[investor, "retail"], [other, "retail"], [wholesaleOnly, "wholesale"]] as const)
    await mem.repo.addDeclaration({ id: U(d++), userId: a.userId, category: cat, disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: clock });
});

async function project(over: Record<string, unknown> = {}) {
  const r = await createProject(deps, owner, { ...fields, ...over });
  if (!r.ok) throw new Error(r.message);
  const p = (await mem.repo.getProject(r.value.project.id))!;
  expect((await decideProject(deps, admin, p.id, "approve", "Checked issuer and risks.", p.version)).ok).toBe(true);
  return p.id;
}
const addDoc = async (projectId: string, over: { visibility?: "investors" | "team"; confirmed?: boolean; supersedes?: string; at?: string } = {}) => {
  const docId = id();
  await docs.store.addDocument({
    record: { id: docId, projectId, kind: "feasibility", visibility: over.visibility ?? "investors", title: "Secret Street 12", uploadedBy: owner.userId, contentType: "application/pdf", sizeBytes: 10, uploadedAt: over.at ?? clock, ...(over.supersedes ? { supersedesId: over.supersedes } : {}) },
    storageKey: `k/${docId}`, sha256: "a".repeat(64)
  });
  if (over.confirmed !== false) await docs.store.addMask({ id: id(), documentId: docId, revision: 1, boxes: [], terms: [], pageCount: 1, textFound: true, confirmed: true, actorId: admin.id, createdAt: clock });
  return docId;
};
const update = (projectId: string, title: string, at: string, status: "draft" | "published" = "published") =>
  elena.addUpdate({ id: id(), projectId, title, body: "A body of more than twenty characters.", status, sourceDocIds: [], createdBy: "owner", createdByUser: owner.userId, createdAt: at, ...(status === "published" ? { approvedBy: owner.userId, approvedAt: at } : {}) });
const run = (who: Actor = investor) => buildPortfolio(deps, elena, docs.store, who);

describe("investor portfolio", () => {
  it("is empty for an investor with nothing followed or registered", async () => {
    const r = await run();
    expect(r).toEqual({ ok: true, value: { summary: expect.objectContaining({ projects: 0, interests: 0, indicativeMinCents: 0 }), projects: [], truncated: false } });
  });

  it("is for buyer accounts only", async () => {
    const r = await run(owner);
    expect(r.ok).toBe(false);
  });

  it("combines followed projects and registered interest, once per project, with the indicative range", async () => {
    const a = await project(), b = await project({ title: "Harbour units" });
    await elena.setFollow(a, investor.userId, true, clock);
    await elena.setFollow(b, investor.userId, true, clock);
    const i = await expressInterest(deps, investor, b, { message: "Interested in the numbers.", amountMinCents: 5_000_000, amountMaxCents: 10_000_000 });
    expect(i.ok).toBe(true);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.projects.map(p => p.title).sort()).toEqual(["Harbour units", "Riverside townhouses"]);
    expect(r.value.summary).toMatchObject({ projects: 2, following: 2, interests: 1, indicativeMinCents: 5_000_000, indicativeMaxCents: 10_000_000 });
    const withInterest = r.value.projects.find(p => p.id === b)!;
    expect(withInterest.interest).toMatchObject({ contractStatus: "none", amountMinCents: 5_000_000 });
    expect(r.value.projects.find(p => p.id === a)!.interest).toBeUndefined();
  });

  it("leaves out a project the investor may no longer see and never shows other investors' data", async () => {
    const open = await project(), wholesale = await project({ title: "Wholesale only", visibleTo: "wholesale_only" });
    await elena.setFollow(open, investor.userId, true, clock);
    await elena.setFollow(wholesale, investor.userId, true, clock);   // retail investor cannot see it
    await elena.setFollow(open, other.userId, true, clock);
    const r = await run();
    expect(r.ok && r.value.projects.map(p => p.id)).toEqual([open]);
    expect(r.ok && r.value.summary.following).toBe(1);
  });

  it("counts only current, investor-visible, mask-confirmed documents, and never names them", async () => {
    const p = await project();
    await elena.setFollow(p, investor.userId, true, clock);
    const old = await addDoc(p, { at: "2026-11-01T00:00:00.000Z" });
    await addDoc(p, { supersedes: old, at: "2026-11-10T00:00:00.000Z" });
    await addDoc(p, { confirmed: false });
    await addDoc(p, { visibility: "team" });
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.projects[0]!.documents).toEqual({ available: 1, waitingForMasking: 1, lastAddedAt: "2026-11-10T00:00:00.000Z" });
    expect(JSON.stringify(r.value)).not.toContain("Secret Street");
  });

  it("shows published updates only, newest first, flags the recent ones, and never a draft", async () => {
    const p = await project();
    await elena.setFollow(p, investor.userId, true, clock);
    await update(p, "Old news", "2026-09-01T00:00:00.000Z");
    await update(p, "Fresh news", "2026-11-18T00:00:00.000Z");
    await update(p, "Unapproved draft", "2026-11-19T00:00:00.000Z", "draft");
    const r = await run();
    if (!r.ok) throw new Error(r.message);
    const u = r.value.projects[0]!.updates;
    expect(u.items.map(x => x.title)).toEqual(["Fresh news", "Old news"]);
    expect(u).toMatchObject({ newCount: 1 });
    expect(r.value.summary.newUpdates).toBe(1);
  });

  it("summarises the investor's own Elena questions and owner replies, not other investors'", async () => {
    const p = await project();
    await elena.setFollow(p, investor.userId, true, clock);
    const q = (who: Actor, outcome: "answered" | "escalated") => ({ id: id(), projectId: p, askerUserId: who.userId, question: "What is the cost?", answer: "x", outcome, sources: [], createdAt: clock });
    const mine = q(investor, "answered"), esc = q(investor, "escalated");
    await elena.addQuestion(mine); await elena.addQuestion(esc); await elena.addQuestion(q(other, "answered"));
    await elena.addReply({ id: id(), questionId: esc.id, ownerUserId: owner.userId, body: "Here is the answer.", createdAt: clock });
    const r = await run();
    if (!r.ok) throw new Error(r.message);
    expect(r.value.projects[0]!.questions).toEqual({ asked: 2, answered: 1, passedToOwner: 1, ownerReplies: 1, recentOwnerReplies: 1 });
    expect(r.value.projects[0]!.attention.join(" ")).toMatch(/owner replied/);
  });

  it("caps the list and says so", async () => {
    for (let i = 0; i < 32; i++) await elena.setFollow(U(500 + i), investor.userId, true, clock);
    const r = await run();
    expect(r.ok && r.value.truncated).toBe(true);
  });

  it("writes nothing", async () => {
    const p = await project();
    await elena.setFollow(p, investor.userId, true, clock);
    const before = JSON.stringify([elena.questions, elena.updates, [...elena.follows]]);
    await run();
    expect(JSON.stringify([elena.questions, elena.updates, [...elena.follows]])).toBe(before);
  });
});

describe("attentionFor", () => {
  const base = { documents: { available: 1, waitingForMasking: 0 }, updates: { items: [], newCount: 0 }, questions: { asked: 0, answered: 0, passedToOwner: 0, ownerReplies: 0, recentOwnerReplies: 0 } };
  it("says nothing when there is nothing to do", () => expect(attentionFor(base)).toEqual([]));
  it("flags a returned contract, waiting documents and an empty document room", () => {
    expect(attentionFor({ ...base, interest: { amountMinCents: 1, amountMaxCents: 2, contractStatus: "returned", since: "", threadId: "" }, documents: { available: 0, waitingForMasking: 2 } }).join("|"))
      .toMatch(/returned.*2 documents waiting.*them/);
    expect(attentionFor({ ...base, documents: { available: 0, waitingForMasking: 0 } })[0]).toMatch(/not published any documents/);
  });
});
