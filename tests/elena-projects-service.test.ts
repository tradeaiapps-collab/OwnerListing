import { beforeEach, describe, expect, it } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { AuditEvent } from "../src/domain/audit";
import {
  approveUpdate, askElena, decideAnswer, setAnswerMode, getAnswerMode, clearDocTextCache, createInMemoryElenaStore, draftForOwner, editDraft, listQuestions, listUpdates, replyToQuestion, reviewForOwner, setFollow,
  type DocTextPort, type ElenaPorts
} from "../src/domain/elena-projects-service";
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
let store: ReturnType<typeof createInMemoryElenaStore>, ports: ElenaPorts, objects: Map<string, Uint8Array>, audit: AuditEvent[], notices: { to: string; template: string; text: string }[];
let hits = 1, clock = "2026-11-20T00:00:00.000Z", n = 0;
/** What each stored file "reads" as, by the tag inside the fake PDF. */
const pagesByTag: Record<string, string[]> = {};
const text: DocTextPort = { async pages(bytes) { const tag = Buffer.from(bytes).toString().split("\n")[1] ?? ""; return pagesByTag[tag] ?? []; } };

beforeEach(async () => {
  clearDocTextCache();
  n = 0; hits = 1; clock = "2026-11-20T00:00:00.000Z"; audit = []; notices = []; objects = new Map();
  for (const k of Object.keys(pagesByTag)) delete pagesByTag[k];
  mem = createInMemoryInvestmentRepository(); docs = createInMemoryProjectDocStore(); store = createInMemoryElenaStore();
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
  // Earlier suites test instant quoting; the approve-first default has its own suite below.
  await store.setAnswerMode(p.id, "instant", owner.userId, clock);
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
const ask = (id: string, q: unknown, who: Actor = investor) => askElena(deps, store, docs.store, ports, who, id, q);

describe("investor questions", () => {
  it("answers by quoting a confirmed investor document with its page, logs it, and shows the not-advice notice", async () => {
    const id = await approvedProject();
    await addDoc(projectId(id), "Feasibility study", ["Introduction to the project.", "Construction cost is estimated at $4,200,000 including contingency."]);
    const r = await ask(id, "What is the construction cost estimate?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe("answered");
    expect(r.value.sources[0]).toMatchObject({ title: "Feasibility study", page: 2 });
    expect(r.value.text).toContain("$4,200,000");
    expect(r.value.notice).toMatch(/not financial advice/i);
    expect(store.questions).toHaveLength(1);
    expect(audit.some(e => e.eventType === "investment.elena_question" && e.payload["outcome"] === "answered")).toBe(true);
    expect(notices).toHaveLength(0);
  });

  it("reads only current, investor-visible, mask-confirmed documents", async () => {
    const id = await approvedProject();
    await addDoc(id, "Unconfirmed", ["The secret figure is $111,000."], { confirm: false });
    await addDoc(id, "Private", ["The secret figure is $222,000."], { visibility: "private" });
    await addDoc(id, "Team only", ["The secret figure is $333,000."], { visibility: "team" });
    const old = await addDoc(id, "Old version", ["The secret figure is $444,000."]);
    await addDoc(id, "New version", ["The secret figure is $555,000."], { supersedesId: old });
    const r = await ask(id, "What is the secret figure?");
    expect(r.ok && r.value.text).toContain("$555,000");
    expect(r.ok && r.value.text).not.toMatch(/\$111,000|\$222,000|\$333,000|\$444,000/);
  });

  it("never shows the masked address, even where the mask terms are unusual", async () => {
    const id = await approvedProject();
    await addDoc(id, "Site report", ["The Harbour House site has good access and the soil report is clean.", "Services are connected at the boundary."], { terms: ["Harbour House"] });
    const r = await ask(id, "What does the report say about the site and soil?");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/Harbour/);
    const addr = await ask(id, "What is the exact address of the site?");
    expect(addr.ok && addr.value.outcome).toBe("escalated");
  });

  it("passes unanswerable questions to the owner with a notice, declines advice and commitments without bothering the owner", async () => {
    const id = await approvedProject();
    const unknown = await ask(id, "What is the builder's insurance excess?");
    expect(unknown.ok && unknown.value.outcome).toBe("escalated");
    expect(notices.filter(x => x.to === owner.userId && x.template === "elena_project_question")).toHaveLength(1);
    expect(notices[0]!.text).not.toMatch(/insurance/);
    expect((await ask(id, "Will I make a guaranteed 20 percent return?")).ok).toBe(true);
    expect((await ask(id, "Please reserve me a unit"))).toMatchObject({ ok: true, value: { outcome: "declined" } });
    expect(notices).toHaveLength(1);
    expect(store.questions.map(q => q.outcome)).toEqual(["escalated", "declined", "declined"]);
  });

  it("is limited to people who may see the project, never the owner, and refuses contact details without storing them", async () => {
    const id = await approvedProject();
    for (const who of [unverified, stranger]) { const r = await ask(id, "What is the timeline?", who); expect(!r.ok && r.code).toBe("not_found"); }
    expect((await askElena(deps, store, docs.store, ports, investor, U(777), "What is the timeline?")).ok).toBe(false);
    const own = await ask(id, "What is the timeline?", owner);
    expect(!own.ok && own.code).toBe("forbidden");
    const r = await ask(id, "Call me on 0412 345 678 about the timeline");
    expect(!r.ok && r.code).toBe("invalid");
    expect(store.questions).toHaveLength(0);
  });

  it("is rate limited and fails closed when the counter fails", async () => {
    const id = await approvedProject();
    hits = 21;
    const r = await ask(id, "What is the timeline?");
    expect(!r.ok && r.code).toBe("rate_limited");
    deps.countHit = async () => undefined;
    expect((await ask(id, "What is the timeline?")).ok).toBe(false);
    expect(store.questions).toHaveLength(0);
  });

  it("an unapproved project is invisible to investors", async () => {
    const r = await createProject(deps, owner, fields);
    const id = r.ok ? r.value.project.id : "";
    const a = await ask(id, "What is the timeline?");
    expect(!a.ok && a.code).toBe("not_found");
  });
});

const projectId = (x: string) => x;

describe("owner view and replies", () => {
  it("the owner sees every question and answer; an investor sees only their own; a stranger sees nothing", async () => {
    const id = await approvedProject();
    await ask(id, "What is the builder's insurance excess?");
    await ask(id, "What is the timeline?", other);
    const o = await listQuestions(deps, store, owner, id);
    expect(o.ok && o.value.questions).toHaveLength(2);
    const i = await listQuestions(deps, store, investor, id);
    expect(i.ok && i.value.questions.map(q => q.question)).toEqual(["What is the builder's insurance excess?"]);
    expect((await listQuestions(deps, store, stranger, id)).ok).toBe(false);
    expect(JSON.stringify(i)).not.toContain(other.userId);
  });

  it("the owner replies, the asker is notified without the text, and nobody else can reply", async () => {
    const id = await approvedProject();
    const q = await ask(id, "What is the builder's insurance excess?");
    const qid = q.ok ? q.value.id : "";
    for (const who of [investor, stranger, other]) expect((await replyToQuestion(deps, store, who, id, qid, "The excess is $5,000.")).ok).toBe(false);
    expect((await replyToQuestion(deps, store, owner, id, qid, "Call me on 0412 345 678")).ok).toBe(false);
    expect((await replyToQuestion(deps, store, owner, id, qid, "12 Smith Street is the site")).ok).toBe(false);
    const r = await replyToQuestion(deps, store, owner, id, qid, "The excess is five thousand dollars.");
    expect(r.ok).toBe(true);
    const n1 = notices.find(x => x.template === "elena_project_reply")!;
    expect(n1.to).toBe(investor.userId);
    expect(n1.text).not.toMatch(/excess/);
    const mine = await listQuestions(deps, store, investor, id);
    expect(mine.ok && mine.value.questions[0]!.replies[0]!.body).toContain("five thousand");
    const wrongProject = await replyToQuestion(deps, store, owner, U(888), qid, "Some reply here");
    expect(wrongProject.ok).toBe(false);
  });
});

describe("keeping the project current", () => {
  it("flags what is missing for the stage and counts new documents", async () => {
    const id = await approvedProject();
    const r = await reviewForOwner(deps, store, docs.store, owner, id);
    expect(r.ok && r.value.flags.map(f => f.id)).toEqual(expect.arrayContaining(["missing-plan", "missing-feasibility"]));
    await addDoc(id, "Plans", ["Floor plans for six townhouses."], { kind: "plan" });
    const r2 = await reviewForOwner(deps, store, docs.store, owner, id);
    expect(r2.ok && r2.value.newDocuments).toBe(1);
    expect((await reviewForOwner(deps, store, docs.store, investor, id)).ok).toBe(false);
  });

  it("drafts from new documents, keeps the draft private, publishes only on the owner's approval and then notifies followers once", async () => {
    const id = await approvedProject();
    expect((await draftForOwner(deps, store, docs.store, ports, owner, id)).ok).toBe(false); // nothing new yet
    await addDoc(id, "Council approval", ["Council has approved the development application. Conditions must be met within 24 months of approval."], { kind: "approval" });
    expect((await setFollow(deps, store, investor, id, true)).ok).toBe(true);
    expect((await setFollow(deps, store, owner, id, true)).ok).toBe(false);
    const d = await draftForOwner(deps, store, docs.store, ports, owner, id);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value).toMatchObject({ status: "draft", createdBy: "elena" });
    expect(d.value.body).toContain("Council approval");
    // The draft is invisible to investors and nobody has been told.
    const seen = await listUpdates(deps, store, investor, id);
    expect(seen.ok && seen.value.updates).toHaveLength(0);
    expect(seen.ok && seen.value.following).toBe(true);
    expect(notices.filter(x => x.template === "project_update")).toHaveLength(0);
    expect((await draftForOwner(deps, store, docs.store, ports, owner, id)).ok).toBe(false); // one open draft at a time
    // Only the owner can edit or approve; edits are validated.
    for (const who of [investor, stranger]) { expect((await approveUpdate(deps, store, who, id, d.value.id)).ok).toBe(false); expect((await editDraft(deps, store, who, id, d.value.id, { title: "Hacked", body: "Some other text for investors." })).ok).toBe(false); }
    expect((await editDraft(deps, store, owner, id, d.value.id, { title: "Approval received", body: "Call 0412 345 678 about approval." })).ok).toBe(false);
    expect((await editDraft(deps, store, owner, id, d.value.id, { title: "Approval received", body: "Council approval has been received; the build starts next quarter." })).ok).toBe(true);
    const done = await approveUpdate(deps, store, owner, id, d.value.id);
    expect(done).toEqual({ ok: true, value: { notified: 1 } });
    expect(notices.filter(x => x.template === "project_update")).toEqual([expect.objectContaining({ to: investor.userId })]);
    expect(notices.find(x => x.template === "project_update")!.text).not.toMatch(/Council approval has been received/);
    const after = await listUpdates(deps, store, investor, id);
    expect(after.ok && after.value.updates.map(u => u.title)).toEqual(["Approval received"]);
    expect(after.ok && JSON.stringify(after.value)).not.toContain(owner.userId);
    // Published updates are final.
    expect((await approveUpdate(deps, store, owner, id, d.value.id)).ok).toBe(false);
    expect((await editDraft(deps, store, owner, id, d.value.id, { title: "Changed later", body: "Quietly rewritten after publishing." })).ok).toBe(false);
    expect(audit.map(e => e.eventType)).toEqual(expect.arrayContaining(["investment.project_update_drafted", "investment.project_update_published"]));
  });

  it("does not notify an investor who has stopped following or can no longer see the project", async () => {
    const id = await approvedProject();
    await addDoc(id, "Council approval", ["Council has approved the development application for the project."], { kind: "approval" });
    await setFollow(deps, store, investor, id, true);
    await setFollow(deps, store, other, id, true);
    await setFollow(deps, store, other, id, false);
    const d = await draftForOwner(deps, store, docs.store, ports, owner, id);
    const r = d.ok ? await approveUpdate(deps, store, owner, id, d.value.id) : d;
    expect(r.ok && r.value.notified).toBe(1);
  });

  it("will not publish while the project is not approved", async () => {
    const r = await createProject(deps, owner, fields);
    const id = r.ok ? r.value.project.id : "";
    await addDoc(id, "Plans", ["Floor plans for six townhouses in the project."], { kind: "plan" });
    const d = await draftForOwner(deps, store, docs.store, ports, owner, id);
    expect(d.ok).toBe(true);
    const p = d.ok ? await approveUpdate(deps, store, owner, id, d.value.id) : d;
    expect(!p.ok && p.code).toBe("conflict");
  });
});

describe("security review fixes (service)", () => {
  it("a document title with an address never reaches an investor's source label or the owner's draft", async () => {
    const id = await approvedProject();
    await addDoc(id, "Site plan 12 Smith St", ["Landscaping and stormwater works are completed before occupancy."], { kind: "plan" });
    const r = await ask(id, "What does the plan say about landscaping and stormwater?");
    expect(r.ok && r.value.outcome).toBe("answered");
    expect(JSON.stringify(r)).not.toMatch(/Smith/);
    expect(r.ok && r.value.sources[0]!.title).toBe("Plans");
    const stored = JSON.stringify(store.questions);
    expect(stored).not.toMatch(/Smith/);
    const d = await draftForOwner(deps, store, docs.store, ports, owner, id);
    expect(d.ok && d.value.body).not.toMatch(/Smith/);
  });
  it("a guaranteed-return sentence in a document is not quoted", async () => {
    const id = await approvedProject();
    await addDoc(id, "Info memo", ["Investors receive a guaranteed 12% return each year."]);
    const r = await ask(id, "What does the memo say about payments each year?");
    expect(r.ok && r.value.outcome).toBe("declined");
    expect(JSON.stringify(r)).not.toMatch(/12%/);
    expect(notices).toHaveLength(0);
  });
});

describe("owner approves Elena's drafted answers (approve-first)", () => {
  async function draftedProject() {
    const id = await approvedProject();
    await setAnswerMode(deps, store, owner, id, "approve_first");
    await addDoc(id, "Feasibility study", ["Construction cost is estimated at $4,200,000 including contingency."]);
    return id;
  }
  const pending = async (id: string) => { const r = await ask(id, "What is the construction cost estimate?"); if (!r.ok) throw new Error(r.message); return r.value; };
  const mine = async (id: string, who: Actor) => { const r = await listQuestions(deps, store, who, id); if (!r.ok) throw new Error(r.message); return r.value; };

  it("defaults to approve-first and shows the investor a holding message, not the draft", async () => {
    const id = await approvedProject();
    store.questions.length = 0;
    await setAnswerMode(deps, store, owner, id, "approve_first");
    await addDoc(id, "Feasibility study", ["Construction cost is estimated at $4,200,000."]);
    const a = await pending(id);
    expect(a.pending).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/4,200,000/);
    const inv = await mine(id, investor);
    expect(inv.questions[0]).toMatchObject({ state: "pending_owner", sources: [] });
    expect(JSON.stringify(inv)).not.toMatch(/4,200,000/);
    expect(inv.questions[0]!.draft).toBeUndefined();
    expect(notices.some(x => x.to === owner.userId && x.template === "elena_project_draft")).toBe(true);
  });

  it("a fresh project with no setting is approve-first", async () => {
    const r = await createProject(deps, owner, fields);
    if (!r.ok) throw new Error(r.message);
    expect(await store.answerMode(r.value.project.id)).toBe("approve_first");
  });

  it("the owner sees Elena's draft; approving releases it to the asker only and notifies them", async () => {
    const id = await draftedProject();
    const a = await pending(id);
    const own = await mine(id, owner);
    expect(own.questions[0]!.draft?.text).toContain("$4,200,000");
    expect(own.answerMode).toBe("approve_first");
    expect((await decideAnswer(deps, store, owner, id, a.id, "approve")).ok).toBe(true);
    const inv = await mine(id, investor);
    expect(inv.questions[0]).toMatchObject({ state: "owner_approved" });
    expect(inv.questions[0]!.answer).toContain("$4,200,000");
    expect((await mine(id, other)).questions).toHaveLength(0);
    expect(notices.some(x => x.to === investor.userId && x.template === "elena_project_answer" && !/4,200,000/.test(x.text))).toBe(true);
    expect(audit.some(e => e.eventType === "investment.elena_answer_reviewed" && e.payload["decision"] === "approved")).toBe(true);
  });

  it("an edit replaces Elena's wording with the owner's, and the draft never reaches the investor", async () => {
    const id = await draftedProject();
    const a = await pending(id);
    expect((await decideAnswer(deps, store, owner, id, a.id, "edit", "Budget is in the feasibility study; please read it with its risks.")).ok).toBe(true);
    const inv = await mine(id, investor);
    expect(inv.questions[0]).toMatchObject({ state: "owner_edited", answer: "Budget is in the feasibility study; please read it with its risks.", sources: [] });
    expect(JSON.stringify(inv)).not.toMatch(/4,200,000/);
  });

  it("a discard tells the investor the owner will reply, and the owner can then reply", async () => {
    const id = await draftedProject();
    const a = await pending(id);
    expect((await replyToQuestion(deps, store, owner, id, a.id, "Hello there")).ok).toBe(false);
    expect((await decideAnswer(deps, store, owner, id, a.id, "discard")).ok).toBe(true);
    const inv = await mine(id, investor);
    expect(inv.questions[0]).toMatchObject({ state: "owner_discarded", sources: [] });
    expect(inv.questions[0]!.answer).toMatch(/owner will answer/i);
    expect((await replyToQuestion(deps, store, owner, id, a.id, "Hello there")).ok).toBe(true);
  });

  it("allows one decision only", async () => {
    const id = await draftedProject();
    const a = await pending(id);
    expect((await decideAnswer(deps, store, owner, id, a.id, "approve")).ok).toBe(true);
    const again = await decideAnswer(deps, store, owner, id, a.id, "discard");
    expect(!again.ok && again.code).toBe("conflict");
  });

  it("refuses edits with return promises, contact details or an address, and bad decisions", async () => {
    const id = await draftedProject();
    const a = await pending(id);
    for (const body of ["You are guaranteed a strong result.", "Call me on 0412 345 678 for the cost.", "It is at 12 Smith Street Bulimba.", "Projected returns of 12% per annum."])
      expect((await decideAnswer(deps, store, owner, id, a.id, "edit", body)).ok).toBe(false);
    expect((await decideAnswer(deps, store, owner, id, a.id, "maybe")).ok).toBe(false);
    expect((await mine(id, investor)).questions[0]!.state).toBe("pending_owner");
  });

  it("only the owner decides; investors, other owners and wrong projects get not found", async () => {
    const id = await draftedProject();
    const a = await pending(id);
    for (const who of [investor, other, stranger]) { const r = await decideAnswer(deps, store, who, id, a.id, "approve"); expect(!r.ok && r.code).toBe("not_found"); }
    expect((await setAnswerMode(deps, store, investor, id, "instant")).ok).toBe(false);
    expect((await getAnswerMode(deps, store, stranger, id)).ok).toBe(false);
    expect((await setAnswerMode(deps, store, owner, id, "whatever")).ok).toBe(false);
  });

  it("declines and escalations never wait for approval, and Elena commits to nothing", async () => {
    const id = await draftedProject();
    const adv = await ask(id, "Will I make a profit?");
    expect(adv.ok && adv.value.outcome).toBe("declined");
    expect(adv.ok && adv.value.pending).toBeUndefined();
    const esc = await ask(id, "Who is the town planner on the project?");
    expect(esc.ok && esc.value.outcome).toBe("escalated");
    expect(esc.ok && esc.value.pending).toBeUndefined();
    const r = await decideAnswer(deps, store, owner, id, adv.ok ? adv.value.id : "", "approve");
    expect(!r.ok && r.code).toBe("conflict");
  });

  it("instant mode keeps the earlier behaviour", async () => {
    const id = await draftedProject();
    await setAnswerMode(deps, store, owner, id, "instant");
    const a = await pending(id);
    expect(a.pending).toBeUndefined();
    expect(a.text).toContain("$4,200,000");
  });
});
