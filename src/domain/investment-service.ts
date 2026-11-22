import type { MalwareScanPort } from "../adapters/malware-scan";
import type { ObjectStoragePort } from "../adapters/object-storage";
import type { AuditEvent } from "./audit";
import { canContactSeller, nextVerificationStep, verificationSteps, type BuyerVerification } from "./buyer";
import { sniffMime } from "./file-sniff";
import {
  contactsDisclosed, contractTransition, feeAmount, feeTransition, maskContacts, MASKED_NOTICE, termsFrom,
  type ContractStatus, type FeeStatus, type PostingSettings
} from "./investment-terms";
import {
  categoryMaySee, cleanText, isCents, investorStep, ownerMayEdit, reviewProject, validateDeclaration, validateInterest, validateProject,
  type InvestmentProject, type InvestorDeclaration, type ModuleState, type ProjectFields, type ProjectStatus, type ReviewOutcome
} from "./investor-projects";
import type { Actor, Failure, Result } from "./listing-service";
import { INVESTMENT_RATE, withinLimit } from "./rate-limit";
import { staffCan, type StaffActor } from "./staff-access";

/** One non-binding expression of interest by one investor in one project; the conversation and the signed contract hang off it. */
export interface Interest {
  id: string; projectId: string; investorUserId: string; amountMinCents: number; amountMaxCents: number; createdAt: string;
  contractStatus: ContractStatus;
}
export interface InvestmentMessage { id: string; interestId: string; senderUserId: string; body: string; sentAt: string }
export interface StatusChange {
  id: string; projectId: string; fromStatus: ProjectStatus | null; toStatus: ProjectStatus;
  actorType: "owner" | "staff"; actorId: string; reason: string | null; projectVersion: number; at: string;
}
export interface ContractChange { id: string; interestId: string; fromStatus: ContractStatus; toStatus: ContractStatus; actorType: "investor" | "staff"; actorId: string; reason: string | null; at: string }
export interface ContractFile { id: string; interestId: string; uploadedBy: string; storageKey: string; sha256: string; sizeBytes: number; uploadedAt: string }
export interface Fee { id: string; interestId: string; projectId: string; ownerUserId: string; amountCents: number; status: FeeStatus; createdAt: string }
export interface FeeChange { id: string; feeId: string; fromStatus: FeeStatus | null; toStatus: FeeStatus; actorId: string; reason: string | null; at: string }
export interface ThreadItem { interest: Interest; projectTitle: string; role: "investor" | "owner" }
export type InvestmentCounts = Record<ProjectStatus, number> & { interests: number; declarations: number; contractsSubmitted: number; feesDue: number };

/** Status history, declarations, messages, contract files and fee history are insert-only (no update or delete here or in the database). */
export interface InvestmentRepository {
  createProject(p: InvestmentProject, h: StatusChange): Promise<void>;
  /** Saves only if the stored version is still `expectedVersion`. False = someone else changed it first. Terms are never changed. */
  updateProject(p: InvestmentProject, expectedVersion: number, h: StatusChange): Promise<boolean>;
  decide(projectId: string, expectedVersion: number, status: ProjectStatus, reason: string, h: StatusChange): Promise<boolean>;
  getProject(id: string): Promise<InvestmentProject | undefined>;
  listByStatus(status: ProjectStatus): Promise<InvestmentProject[]>;
  listByOwner(ownerUserId: string): Promise<InvestmentProject[]>;
  latestDeclaration(userId: string): Promise<InvestorDeclaration | undefined>;
  addDeclaration(d: InvestorDeclaration & { id: string }): Promise<void>;
  findInterest(projectId: string, investorUserId: string): Promise<Interest | undefined>;
  getInterest(id: string): Promise<Interest | undefined>;
  addInterest(i: Interest, first: InvestmentMessage): Promise<void>;
  threadsFor(userId: string): Promise<ThreadItem[]>;
  addMessage(m: InvestmentMessage): Promise<void>;
  messages(interestId: string): Promise<InvestmentMessage[]>;
  /** Moves the contract status only if it is still `c.fromStatus`; logs the change; stores the file and creates the fee in the same step. */
  changeContract(c: ContractChange, file?: ContractFile, fee?: { fee: Fee; change: FeeChange }): Promise<boolean>;
  listContracts(status: ContractStatus): Promise<{ interest: Interest; projectTitle: string; file?: ContractFile }[]>;
  latestContractFile(interestId: string): Promise<ContractFile | undefined>;
  getFee(id: string): Promise<Fee | undefined>;
  listFees(filter: { ownerUserId?: string }): Promise<Fee[]>;
  changeFee(c: FeeChange): Promise<boolean>;
  counts(): Promise<InvestmentCounts>;
}

export interface InvestmentDeps {
  repo: InvestmentRepository;
  /** Both keys. Must come back off when anything is unreadable. */
  moduleState: () => Promise<ModuleState>;
  /** Posting model settings in force now (defaults when never set). A throw blocks posting. */
  postingSettings: () => Promise<PostingSettings>;
  /** Missing data must come back all false (fail closed). */
  verification: (userId: string) => Promise<BuyerVerification>;
  /** One hit in a fixed window; undefined or a throw counts as over the limit. */
  countHit: (key: string, windowMs: number) => Promise<number | undefined>;
  /** Display name and email, used only once Model 2 disclosure has unlocked. */
  contactFor: (userId: string) => Promise<{ name: string; email: string } | undefined>;
  /** Email notice from the platform address with a link back to the platform. Never carries a message body or contact details. Never throws. */
  notify: (userId: string, template: string, subject: string, text: string) => Promise<void>;
  /** Signed contract storage. Both fail closed (upload refused) until configured. */
  files: { storage: ObjectStoragePort; scanner: MalwareScanPort };
  /** Model 2 upfront fee checkout through the payments port. Throws while the provider is not connected. */
  startUpfrontCheckout: (p: InvestmentProject) => Promise<{ redirectUrl: string }>;
  sha256: (b: Uint8Array) => Promise<string>;
  appUrl: string;
  appendAudit: (e: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
  /** Abuse and spam filter for what people write. Unset means no filter. Refused text is never stored; `after` runs once a flagged message is stored. */
  contentGuard?: (input: { userId: string; text: string }) => Promise<{ ok: true; after?: (messageId: string) => Promise<void> } | { ok: false; message: string }>;
}

type Fail = Failure & { fields?: Record<string, string>; step?: string };
const fail = (code: Failure["code"], message: string, extra: Partial<Fail> = {}): Fail => ({ ok: false, code, message, ...extra });
const NOT_FOUND = fail("not_found", "Not found.");
const TOO_FAST = fail("rate_limited", "Too many requests. Try again later.");

async function under(deps: InvestmentDeps, key: string, rate: { windowMs: number; perUser: number }): Promise<boolean> {
  try { return withinLimit(await deps.countHit(key, rate.windowMs), rate.perUser); } catch { return false; }
}

const audit = (deps: InvestmentDeps, actorId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId, aggregateType, aggregateId, eventType, correlationId: deps.newId(), payload });

/** What an investor may see: no owner id, no review notes, no fee terms (those are between the platform and the poster). */
export type ProjectView = Omit<InvestmentProject, "ownerUserId" | "reviewReason" | "terms">;
export const toView = ({ ownerUserId: _o, reviewReason: _r, terms: _t, ...rest }: InvestmentProject): ProjectView => rest;

const STEP_TEXT: Record<string, string> = {
  verify_email: "Verify your email first.", verify_phone: "Verify your mobile number first.", verify_id: "Complete the ID check first.",
  declare: "Complete the investor declaration first."
};

/** The investor's verified state and declaration, or the step still to do. Buyer accounts only. */
async function investor(deps: InvestmentDeps, actor: Actor): Promise<Result<InvestorDeclaration>> {
  if (actor.userType !== "buyer") return fail("forbidden", "Use an investor (buyer) account.", { step: "investor_account" });
  const v = await deps.verification(actor.userId);
  const d = await deps.repo.latestDeclaration(actor.userId);
  const step = investorStep(v, d);
  if (step || !d) return fail("forbidden", STEP_TEXT[step ?? "declare"]!, { step: step ?? "declare" });
  return { ok: true, value: d };
}

export async function investorStatus(deps: InvestmentDeps, actor: Actor) {
  if (actor.userType !== "buyer") return fail("forbidden", "Use an investor (buyer) account.", { step: "investor_account" });
  const v = await deps.verification(actor.userId);
  const d = await deps.repo.latestDeclaration(actor.userId);
  return { ok: true as const, value: { steps: verificationSteps(v), next: investorStep(v, d), category: d?.category ?? null, declaredVersion: d?.disclosureVersion ?? null } };
}

export async function declare(deps: InvestmentDeps, actor: Actor, raw: unknown): Promise<Result<InvestorDeclaration>> {
  if (actor.userType !== "buyer") return fail("forbidden", "Use an investor (buyer) account.");
  const v = await deps.verification(actor.userId);
  if (!canContactSeller(v)) return fail("forbidden", STEP_TEXT[nextVerificationStep(v) ?? "verify_id"]!);
  if (!(await under(deps, `inv-decl:${actor.userId}`, INVESTMENT_RATE.declaration))) return TOO_FAST;
  const r = validateDeclaration(raw);
  if (!r.ok) return fail("invalid", r.error);
  const d = { id: deps.newId(), userId: actor.userId, category: r.category, disclosureVersion: (raw as { disclosureVersion: string }).disclosureVersion, declaredAt: deps.now() };
  await deps.repo.addDeclaration(d);
  await audit(deps, actor.userId, "investor_declaration", d.id, "investment.investor_declared", { category: d.category, disclosureVersion: d.disclosureVersion });
  return { ok: true, value: d };
}

export async function browse(deps: InvestmentDeps, actor: Actor): Promise<Result<ProjectView[]>> {
  const inv = await investor(deps, actor);
  if (!inv.ok) return inv;
  const all = await deps.repo.listByStatus("approved");
  return { ok: true, value: all.filter(p => p.ownerUserId !== actor.userId && categoryMaySee(inv.value.category, p.visibleTo)).map(toView) };
}

/** What anyone may see, signed in or not: the card only. Timeline, risks, structure, issuer licence and contact stay with ready investors. */
export type PublicProjectView = Pick<InvestmentProject, "id" | "title" | "location" | "jurisdiction" | "projectType" | "summary" | "stage" | "fundingTargetCents" | "minimumTicketCents" | "issuerName">;
export const toPublicView = (p: InvestmentProject): PublicProjectView => ({
  id: p.id, title: p.title, location: p.location, jurisdiction: p.jurisdiction, projectType: p.projectType, summary: p.summary, stage: p.stage,
  fundingTargetCents: p.fundingTargetCents, minimumTicketCents: p.minimumTicketCents, issuerName: p.issuerName
});

/** Every approved project, for the public list. Only approved projects; the module switch still decides whether any of this is served. */
export async function publicBrowse(deps: InvestmentDeps): Promise<PublicProjectView[]> {
  return (await deps.repo.listByStatus("approved")).map(toPublicView);
}

/** The owner sees their own project in any status. Anyone else: approved, investor-ready and allowed by visibility, or 404. */
export async function viewProject(deps: InvestmentDeps, actor: Actor, id: string): Promise<Result<{ project: ProjectView | InvestmentProject; mine: boolean }>> {
  const p = await deps.repo.getProject(id);
  if (!p) return NOT_FOUND;
  if (p.ownerUserId === actor.userId) return { ok: true, value: { project: p, mine: true } };
  if (p.status !== "approved") return NOT_FOUND;
  const inv = await investor(deps, actor);
  if (!inv.ok || !categoryMaySee(inv.value.category, p.visibleTo)) return NOT_FOUND;
  return { ok: true, value: { project: toView(p), mine: false } };
}

async function mayPost(deps: InvestmentDeps, actor: Actor): Promise<Fail | null> {
  if (actor.userType !== "owner") return fail("forbidden", "Only owner accounts can post projects.");
  const v = await deps.verification(actor.userId);
  if (!canContactSeller(v)) return fail("forbidden", "Verify your email, mobile and identity before posting a project.");
  if (!(await under(deps, `inv-proj:${actor.userId}`, INVESTMENT_RATE.projectWrite))) return TOO_FAST;
  return null;
}

/**
 * Contact details are hidden from every free-text field investors see, the issuer fields included (a name or licence basis is kept,
 * an email, phone or link is not). The licence basis keeps digit runs, so AFSL, ABN and ACN numbers survive. Counsel to confirm.
 */
const MASKED_FIELDS = ["title", "location", "summary", "timeline", "risks", "structureDescription", "issuerName", "issuerStatement", "issuerLicenceBasis"] as const;
function maskProject(f: ProjectFields): { fields: ProjectFields; masked: string[] } {
  const out = { ...f };
  const masked: string[] = [];
  for (const k of MASKED_FIELDS) {
    const m = maskContacts(out[k], { phones: k !== "issuerLicenceBasis" });
    out[k] = m.text;
    if (m.masked) masked.push(k);
  }
  return { fields: out, masked };
}

/** New projects always start in the staff review queue, with the posting terms in force now copied onto them. */
export async function createProject(deps: InvestmentDeps, actor: Actor, raw: unknown): Promise<Result<{ project: InvestmentProject; masked: string[] }>> {
  const no = await mayPost(deps, actor);
  if (no) return no;
  const v = validateProject(raw);
  if (!v.ok) return fail("invalid", "Some fields need attention.", { fields: v.errors });
  let settings: PostingSettings;
  try { settings = await deps.postingSettings(); } catch { return fail("unavailable", "Posting is not available right now."); }
  const { fields, masked } = maskProject(v.value);
  const now = deps.now();
  const p: InvestmentProject = { ...fields, id: deps.newId(), ownerUserId: actor.userId, status: "pending_review", version: 1, terms: termsFrom(settings), createdAt: now, updatedAt: now };
  await deps.repo.createProject(p, { id: deps.newId(), projectId: p.id, fromStatus: null, toStatus: "pending_review", actorType: "owner", actorId: actor.userId, reason: null, projectVersion: 1, at: now });
  await audit(deps, actor.userId, "investment_project", p.id, "investment.project_submitted", { version: 1, postingModel: p.terms.model, masked });
  return { ok: true, value: { project: p, masked } };
}

/** Owner edit. Any change, even after approval, sends the project back to review. The posting terms stay as first posted. */
export async function editProject(deps: InvestmentDeps, actor: Actor, id: string, raw: unknown): Promise<Result<{ project: InvestmentProject; masked: string[] }>> {
  const p = await deps.repo.getProject(id);
  if (!p || p.ownerUserId !== actor.userId) return NOT_FOUND;
  if (!ownerMayEdit(p)) return fail("conflict", "A rejected project cannot be edited.");
  const no = await mayPost(deps, actor);
  if (no) return no;
  const v = validateProject(raw);
  if (!v.ok) return fail("invalid", "Some fields need attention.", { fields: v.errors });
  const { fields, masked } = maskProject(v.value);
  const now = deps.now();
  const { reviewReason: _r, ...base } = p;
  const next: InvestmentProject = { ...base, ...fields, terms: p.terms, status: "pending_review", version: p.version + 1, updatedAt: now };
  const saved = await deps.repo.updateProject(next, p.version, {
    id: deps.newId(), projectId: p.id, fromStatus: p.status, toStatus: "pending_review", actorType: "owner", actorId: actor.userId, reason: null, projectVersion: next.version, at: now
  });
  if (!saved) return fail("conflict", "The project changed meanwhile. Reload and try again.");
  await audit(deps, actor.userId, "investment_project", p.id, "investment.project_edited", { version: next.version, from: p.status, masked });
  return { ok: true, value: { project: next, masked } };
}

export const myProjects = (deps: InvestmentDeps, actor: Actor) => deps.repo.listByOwner(actor.userId);
export const myFees = (deps: InvestmentDeps, actor: Actor) => deps.repo.listFees({ ownerUserId: actor.userId });

/** Staff decision. `version` is the version the reviewer read; a newer edit makes the decision stale (conflict). */
export async function decideProject(deps: InvestmentDeps, staff: StaffActor, id: string, outcome: ReviewOutcome, reason: unknown, version: unknown): Promise<Result<ProjectStatus>> {
  const p = await deps.repo.getProject(id);
  if (!p) return NOT_FOUND;
  const why = cleanText(reason, 10, 2000);
  if (!why.ok) return fail("invalid", `Reason: ${why.error}`);
  const d = reviewProject(p, staff, outcome, why.value);
  if (!d.ok) return fail(d.error === "Not allowed." ? "forbidden" : "conflict", d.error);
  if (version !== p.version) return fail("conflict", "The owner changed the project. Reload and review the new version.");
  const now = deps.now();
  const ok = await deps.repo.decide(p.id, p.version, d.status, why.value, {
    id: deps.newId(), projectId: p.id, fromStatus: p.status, toStatus: d.status, actorType: "staff", actorId: staff.id, reason: why.value, projectVersion: p.version, at: now
  });
  if (!ok) return fail("conflict", "The project changed meanwhile. Reload and try again.");
  await deps.appendAudit({ id: deps.newId(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "investment_project", aggregateId: p.id,
    eventType: "investment.project_reviewed", correlationId: deps.newId(), payload: { role: staff.role, outcome, version: p.version, reason: why.value } });
  return { ok: true, value: d.status };
}

/** Model 2 only: starts the upfront fee checkout. Fails closed (503) while the payment provider is not connected. */
export async function startUpfrontFee(deps: InvestmentDeps, actor: Actor, id: string): Promise<Result<{ redirectUrl: string }>> {
  const p = await deps.repo.getProject(id);
  if (!p || p.ownerUserId !== actor.userId) return NOT_FOUND;
  if (p.terms.model !== "upfront_fee" || p.terms.upfrontFeeStatus !== "unpaid") return fail("conflict", "No upfront fee is due on this project.");
  try {
    return { ok: true, value: await deps.startUpfrontCheckout(p) };
  } catch {
    return fail("unavailable", "Online payment is not available yet.");
  }
}

const notice = (deps: InvestmentDeps, userId: string, template: string, subject: string, path: string, line: string) =>
  deps.notify(userId, template, subject, `${line}\n\nRead and reply on the platform: ${deps.appUrl}${path}\n\nThis is an automatic notice from the platform. Replies to this email are not read.`).catch(() => undefined);

/** Non-binding interest from a ready investor in a project they may see. One conversation per investor per project. */
export async function expressInterest(deps: InvestmentDeps, actor: Actor, projectId: string, raw: unknown): Promise<Result<{ id: string; masked: boolean }>> {
  const seen = await viewProject(deps, actor, projectId);
  if (!seen.ok) return seen;
  if (seen.value.mine) return fail("forbidden", "You cannot express interest in your own project.");
  const r = validateInterest(raw);
  if (!r.ok) return fail("invalid", r.error);
  const existing = await deps.repo.findInterest(projectId, actor.userId);
  if (existing) return fail("conflict", "You already expressed interest. Continue in the conversation.");
  if (!(await under(deps, `inv-int:${actor.userId}`, INVESTMENT_RATE.newInterest))) return TOO_FAST;
  const p = (await deps.repo.getProject(projectId))!;
  const content = deps.contentGuard ? await deps.contentGuard({ userId: actor.userId, text: r.value.message }) : undefined;
  if (content && !content.ok) return fail("invalid", content.message);
  const m = maskContacts(r.value.message); // no contract yet, so contacts are hidden under both models
  const now = deps.now();
  const i: Interest = { id: deps.newId(), projectId, investorUserId: actor.userId, amountMinCents: r.value.amountMinCents, amountMaxCents: r.value.amountMaxCents, createdAt: now, contractStatus: "none" };
  const first: InvestmentMessage = { id: deps.newId(), interestId: i.id, senderUserId: actor.userId, body: m.text, sentAt: now };
  await deps.repo.addInterest(i, first);
  if (content?.after) await content.after(first.id).catch(() => undefined);
  await audit(deps, actor.userId, "investment_interest", i.id, "investment.interest_expressed", { projectId, masked: m.masked });
  await notice(deps, p.ownerUserId, "investment_interest", "New interest in your project", `/investments/threads/${i.id}`, `An investor expressed non-binding interest in "${p.title}".`);
  return { ok: true, value: { id: i.id, masked: m.masked } };
}

/** List items carry no user ids: each side knows the other only as "Investor" or "Project owner". */
export async function threads(deps: InvestmentDeps, actor: Actor) {
  return (await deps.repo.threadsFor(actor.userId)).map(t => ({
    id: t.interest.id, projectId: t.interest.projectId, projectTitle: t.projectTitle, role: t.role, contractStatus: t.interest.contractStatus, createdAt: t.interest.createdAt
  }));
}

/** Parties only (the investor and the project owner); anyone else gets 404. */
async function party(deps: InvestmentDeps, actor: Actor, interestId: string) {
  const i = await deps.repo.getInterest(interestId);
  const p = i ? await deps.repo.getProject(i.projectId) : undefined;
  if (!i || !p) return undefined;
  if (actor.userId === i.investorUserId) return { i, p, role: "investor" as const, other: p.ownerUserId };
  if (actor.userId === p.ownerUserId) return { i, p, role: "owner" as const, other: i.investorUserId };
  return undefined;
}

/** Uses the disclosure rule recorded on the project when posted, never the current admin setting (no retroactive disclosure). */
const disclosed = (p: InvestmentProject, i: Interest): boolean => contactsDisclosed(p.terms, p.terms.model2Disclosure, i.contractStatus);

/**
 * The conversation as one party sees it. No user ids, names, emails or phones of the other party, unless Model 2 disclosure has unlocked.
 * Each message says only whether it is the viewer's own or from the other side.
 */
export async function getThread(deps: InvestmentDeps, actor: Actor, interestId: string) {
  const pt = await party(deps, actor, interestId);
  if (!pt) return NOT_FOUND;
  const open = disclosed(pt.p, pt.i);
  const counterpart = open ? await deps.contactFor(pt.other) : undefined;
  const otherLabel = pt.role === "investor" ? "Project owner" : "Investor";
  return {
    ok: true as const,
    value: {
      id: pt.i.id, projectId: pt.p.id, projectTitle: pt.p.title, role: pt.role, amountMinCents: pt.i.amountMinCents, amountMaxCents: pt.i.amountMaxCents,
      contractStatus: pt.i.contractStatus, postingModel: pt.p.terms.model, contactsHidden: !open, ...(counterpart ? { counterpart } : {}),
      messages: (await deps.repo.messages(pt.i.id)).map(m => ({ id: m.id, from: m.senderUserId === actor.userId ? "You" : otherLabel, mine: m.senderUserId === actor.userId, body: m.body, sentAt: m.sentAt }))
    }
  };
}

/** Insert-only. Contact details are masked unless Model 2 disclosure has unlocked; the sender is told. The other side gets an email notice. */
export async function postMessage(deps: InvestmentDeps, actor: Actor, interestId: string, raw: unknown): Promise<Result<{ id: string; body: string; masked: boolean; notice?: string }>> {
  const pt = await party(deps, actor, interestId);
  if (!pt) return NOT_FOUND;
  if (pt.p.status === "rejected") return fail("conflict", "This conversation is closed.");
  if (pt.role === "investor") {
    const inv = await investor(deps, actor);
    if (!inv.ok) return inv;
  }
  const body = cleanText(raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["body"] : undefined, 1, 4000);
  if (!body.ok) return fail("invalid", `Message: ${body.error}`);
  if (!(await under(deps, `inv-msg:${actor.userId}`, INVESTMENT_RATE.message))) return TOO_FAST;
  const content = deps.contentGuard ? await deps.contentGuard({ userId: actor.userId, text: body.value }) : undefined;
  if (content && !content.ok) return fail("invalid", content.message);
  const m = disclosed(pt.p, pt.i) ? { text: body.value, masked: false } : maskContacts(body.value);
  const msg: InvestmentMessage = { id: deps.newId(), interestId, senderUserId: actor.userId, body: m.text, sentAt: deps.now() };
  await deps.repo.addMessage(msg);
  if (content?.after) await content.after(msg.id).catch(() => undefined);
  await audit(deps, actor.userId, "investment_interest", interestId, "investment.message_sent", { messageId: msg.id, masked: m.masked });
  await notice(deps, pt.other, "investment_message", `New message about "${pt.p.title}"`, `/investments/threads/${interestId}`,
    `You have a new message from the ${pt.role === "investor" ? "investor" : "project owner"} about "${pt.p.title}".`);
  return { ok: true, value: { id: msg.id, body: msg.body, masked: m.masked, ...(m.masked ? { notice: MASKED_NOTICE } : {}) } };
}

export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024;

/**
 * The investor uploads the signed contract (PDF only, sniffed, malware-scanned). Stored files are never deleted.
 * Refused (503) until storage and the scanner are configured.
 */
export async function submitContract(deps: InvestmentDeps, actor: Actor, interestId: string, bytes: Uint8Array): Promise<Result<ContractStatus>> {
  const pt = await party(deps, actor, interestId);
  if (!pt) return NOT_FOUND;
  if (pt.role !== "investor") return fail("forbidden", "The investor uploads the signed contract.");
  const inv = await investor(deps, actor);
  if (!inv.ok) return inv;
  const to = contractTransition(pt.i.contractStatus, "submit");
  if (!to) return fail("conflict", "A signed contract is already with staff or confirmed.");
  if (!deps.files.storage.configured || !deps.files.scanner.configured) return fail("unavailable", "Uploads are not available yet.");
  if (!(await under(deps, `inv-upload:${actor.userId}`, INVESTMENT_RATE.contractUpload))) return TOO_FAST;
  if (bytes.length === 0 || bytes.length > MAX_CONTRACT_BYTES) return fail("invalid", "Upload a PDF of up to 10 MB.");
  if (sniffMime(bytes) !== "application/pdf") return fail("invalid", "Upload the signed contract as a PDF.");
  let verdict: "clean" | "infected";
  try { verdict = await deps.files.scanner.scan(bytes); } catch { return fail("unavailable", "The file could not be checked. Try again later."); }
  if (verdict !== "clean") return fail("invalid", "The file was refused by the security check.");
  const now = deps.now();
  const file: ContractFile = { id: deps.newId(), interestId, uploadedBy: actor.userId, storageKey: `investments/${interestId.replace(/-/g, "")}/${deps.newId().replace(/-/g, "")}`, sha256: await deps.sha256(bytes), sizeBytes: bytes.length, uploadedAt: now };
  await deps.files.storage.put(file.storageKey, bytes, "application/pdf");
  const ok = await deps.repo.changeContract({ id: deps.newId(), interestId, fromStatus: pt.i.contractStatus, toStatus: to, actorType: "investor", actorId: actor.userId, reason: null, at: now }, file);
  if (!ok) return fail("conflict", "The contract status changed meanwhile. Reload and try again.");
  await audit(deps, actor.userId, "investment_interest", interestId, "investment.contract_submitted", { fileId: file.id, sha256: file.sha256, sizeBytes: file.sizeBytes });
  return { ok: true, value: to };
}

/**
 * Staff confirm or send back a signed contract. Confirming sets "contract returned"; under Model 1 the fee becomes due
 * (percentage of the contract amount staff read from the signed copy, or the fixed amount) and the poster gets a fee notice.
 */
export async function decideContract(deps: InvestmentDeps, staff: StaffActor, interestId: string, action: unknown, reason: unknown, contractAmountCents: unknown): Promise<Result<{ status: ContractStatus; feeId?: string }>> {
  if (!staffCan(staff, "investment.review")) return fail("forbidden", "Not allowed.");
  if (action !== "confirm" && action !== "reject") return fail("invalid", "Choose confirm or reject.");
  const why = cleanText(reason, 10, 2000);
  if (!why.ok) return fail("invalid", `Reason: ${why.error}`);
  const i = await deps.repo.getInterest(interestId);
  const p = i ? await deps.repo.getProject(i.projectId) : undefined;
  if (!i || !p) return NOT_FOUND;
  if (staff.id === p.ownerUserId || staff.id === i.investorUserId) return fail("forbidden", "You cannot review a contract you are party to.");
  const to = contractTransition(i.contractStatus, action);
  if (!to) return fail("conflict", "This contract is not waiting for review.");
  const now = deps.now();
  let fee: { fee: Fee; change: FeeChange } | undefined;
  if (to === "returned" && p.terms.model === "commission_on_contract") {
    if (p.terms.commissionType === "percent" && !isCents(contractAmountCents)) return fail("invalid", "Enter the amount in the signed contract.");
    const amount = feeAmount(p.terms, isCents(contractAmountCents) ? contractAmountCents : 0);
    const f: Fee = { id: deps.newId(), interestId, projectId: p.id, ownerUserId: p.ownerUserId, amountCents: amount, status: "due", createdAt: now };
    fee = { fee: f, change: { id: deps.newId(), feeId: f.id, fromStatus: null, toStatus: "due", actorId: staff.id, reason: why.value, at: now } };
  }
  const ok = await deps.repo.changeContract({ id: deps.newId(), interestId, fromStatus: i.contractStatus, toStatus: to, actorType: "staff", actorId: staff.id, reason: why.value, at: now }, undefined, fee);
  if (!ok) return fail("conflict", "The contract status changed meanwhile. Reload and try again.");
  await deps.appendAudit({ id: deps.newId(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "investment_interest", aggregateId: interestId,
    eventType: to === "returned" ? "investment.contract_returned" : "investment.contract_rejected", correlationId: deps.newId(),
    payload: { role: staff.role, reason: why.value, ...(fee ? { feeId: fee.fee.id, feeCents: fee.fee.amountCents } : {}) } });
  if (fee) {
    await notice(deps, p.ownerUserId, "investment_fee_notice", "Platform fee notice", "/investments/mine",
      `The signed contract for "${p.title}" was returned through the platform. Our fee of $${(fee.fee.amountCents / 100).toFixed(2)} is now due. Payment details are on your projects page. This fee is never taken from investor money.`);
  }
  await notice(deps, i.investorUserId, "investment_contract", "Signed contract update", `/investments/threads/${interestId}`,
    to === "returned" ? `Staff confirmed the signed contract for "${p.title}".` : `Staff could not accept the signed contract for "${p.title}". Please check the conversation page.`);
  return { ok: true, value: { status: to, ...(fee ? { feeId: fee.fee.id } : {}) } };
}

/** Staff mark a due fee paid or waived (investment.manage). Logged and audited. */
export async function markFee(deps: InvestmentDeps, staff: StaffActor, feeId: string, to: unknown, reason: unknown): Promise<Result<FeeStatus>> {
  if (!staffCan(staff, "investment.manage")) return fail("forbidden", "Not allowed.");
  const f = await deps.repo.getFee(feeId);
  if (!f) return NOT_FOUND;
  const d = feeTransition(staff, f.status, to, reason);
  if (!d.ok) return fail(d.status === 403 ? "forbidden" : d.status === 409 ? "conflict" : "invalid", d.error);
  const why = cleanText(reason, 10, 2000);
  if (!why.ok) return fail("invalid", `Reason: ${why.error}`);
  const ok = await deps.repo.changeFee({ id: deps.newId(), feeId, fromStatus: f.status, toStatus: d.to, actorId: staff.id, reason: why.value, at: deps.now() });
  if (!ok) return fail("conflict", "This fee changed meanwhile. Reload and try again.");
  await deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: staff.id, aggregateType: "investment_fee", aggregateId: feeId,
    eventType: `investment.fee_${d.to}`, correlationId: deps.newId(), payload: { role: staff.role, reason: why.value, amountCents: f.amountCents } });
  return { ok: true, value: d.to };
}

/** For tests and local runs. Same rules as the Postgres repository, including the version and status checks. */
export function createInMemoryInvestmentRepository() {
  const projects = new Map<string, InvestmentProject>();
  const history: StatusChange[] = [];
  const contractHistory: ContractChange[] = [];
  const contractFiles: ContractFile[] = [];
  const fees = new Map<string, Fee>();
  const feeHistory: FeeChange[] = [];
  const declarations: (InvestorDeclaration & { id: string })[] = [];
  const interests: Interest[] = [];
  const msgs: InvestmentMessage[] = [];
  const repo: InvestmentRepository = {
    async createProject(p, h) { projects.set(p.id, structuredClone(p)); history.push(h); },
    async updateProject(p, v, h) {
      const cur = projects.get(p.id);
      if (cur?.version !== v || cur.status === "rejected") return false;
      projects.set(p.id, { ...structuredClone(p), terms: cur.terms }); history.push(h); return true;
    },
    async decide(id, v, status, reason, h) {
      const p = projects.get(id);
      if (!p || p.version !== v || p.status !== "pending_review") return false;
      projects.set(id, { ...p, status, reviewReason: reason }); history.push(h); return true;
    },
    async getProject(id) { const p = projects.get(id); return p ? structuredClone(p) : undefined; },
    async listByStatus(s) { return [...projects.values()].filter(p => p.status === s).map(p => structuredClone(p)); },
    async listByOwner(o) { return [...projects.values()].filter(p => p.ownerUserId === o).map(p => structuredClone(p)); },
    async latestDeclaration(u) { return declarations.filter(d => d.userId === u).at(-1); },
    async addDeclaration(d) { declarations.push(d); },
    async findInterest(pid, u) { return interests.find(i => i.projectId === pid && i.investorUserId === u); },
    async getInterest(id) { const i = interests.find(x => x.id === id); return i ? { ...i } : undefined; },
    async addInterest(i, m) { interests.push({ ...i }); msgs.push(m); },
    async threadsFor(u) {
      return interests.flatMap((i): ThreadItem[] => {
        const p = projects.get(i.projectId)!;
        if (i.investorUserId === u) return [{ interest: { ...i }, projectTitle: p.title, role: "investor" }];
        if (p.ownerUserId === u) return [{ interest: { ...i }, projectTitle: p.title, role: "owner" }];
        return [];
      });
    },
    async addMessage(m) { msgs.push(m); },
    async messages(id) { return msgs.filter(m => m.interestId === id); },
    async changeContract(c, file, fee) {
      const i = interests.find(x => x.id === c.interestId);
      if (!i || i.contractStatus !== c.fromStatus) return false;
      i.contractStatus = c.toStatus; contractHistory.push(c);
      if (file) contractFiles.push(file);
      if (fee) { fees.set(fee.fee.id, { ...fee.fee }); feeHistory.push(fee.change); }
      return true;
    },
    async listContracts(s) {
      return interests.filter(i => i.contractStatus === s).map(i => {
        const file = contractFiles.filter(f => f.interestId === i.id).at(-1);
        return { interest: { ...i }, projectTitle: projects.get(i.projectId)!.title, ...(file ? { file } : {}) };
      });
    },
    async latestContractFile(id) { return contractFiles.filter(f => f.interestId === id).at(-1); },
    async getFee(id) { const f = fees.get(id); return f ? { ...f } : undefined; },
    async listFees(q) { return [...fees.values()].filter(f => !q.ownerUserId || f.ownerUserId === q.ownerUserId).map(f => ({ ...f })); },
    async changeFee(c) {
      const f = fees.get(c.feeId);
      if (!f || f.status !== c.fromStatus) return false;
      f.status = c.toStatus; feeHistory.push(c); return true;
    },
    async counts() {
      const c = { pending_review: 0, approved: 0, changes_requested: 0, rejected: 0, interests: interests.length, declarations: new Set(declarations.map(d => d.userId)).size,
        contractsSubmitted: interests.filter(i => i.contractStatus === "submitted").length, feesDue: [...fees.values()].filter(f => f.status === "due").length };
      for (const p of projects.values()) c[p.status]++;
      return c;
    }
  };
  return { repo, history, contractHistory, contractFiles, feeHistory, declarations, messages: msgs, fees };
}
