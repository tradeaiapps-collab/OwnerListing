import { documentHash, formatDate, parseFieldValues, parseStoredContent, renderClauses, sameName, type Builtins, type RenderedClause, type TemplateCategory, type TemplateContent } from "./doc-templates";
import type { Actor, Failure, Result } from "./listing-service";

/**
 * Generating documents from published templates and collecting e-signatures. Built-in signing: each signer signs in to their own
 * account, reads the document, types their name and ticks consent; the signature records the SHA-256 of the exact text signed, the time,
 * the address and browser. Every step is an insert-only event. The owner generates and sends; signers must have active accounts.
 * The AI assistant explains clauses (text written and reviewed by staff with the template) but never signs, and never changes the text.
 */
export const MAX_SIGNERS = 6;
export const EXPLAIN_DISCLAIMER = "General information to help you understand this clause. It is not legal advice and does not change the document. Ask a solicitor if you are unsure.";

export type DocStatus = "draft" | "out_for_signature" | "completed" | "declined" | "cancelled";
export type EventType = "created" | "sent" | "viewed" | "explained" | "signed" | "declined" | "completed" | "cancelled" | "voided" | "retried" | "stored" | "owner_viewed" | "sign_failed";
/** Why a document was read or a signature refused, stored as `viewReason` in the event detail (security review 2026-10). */
export type ViewReason = "owner-check" | "dispute-support" | "sign-attempt";
export const VIEW_REASONS: readonly ViewReason[] = ["owner-check", "dispute-support", "sign-attempt"];
/** The owner's own reads are logged, but at most one entry per this long, so refreshing the page does not flood the trail. */
export const OWNER_VIEW_LOG_GAP_MS = 10 * 60 * 1000;
export type SigningProvider = "builtin" | "docusign";
export type ArtifactKind = "signed_pdf" | "certificate";
export interface ArtifactRow { id: string; kind: ArtifactKind; sha256: string; sizeBytes: number; createdAt: string }
export interface NewArtifact { kind: ArtifactKind; storageKey: string; sha256: string; sizeBytes: number }
export interface SignerContact { signerId: string; userId: string; name: string; email: string; roleLabel: string; recipientId?: string }

export interface SigningListing { id: string; ownerUserId: string; ownerName: string; title: string; address: string; jurisdiction: string }
export interface PublishedTemplate { templateId: string; key: string; title: string; category: TemplateCategory; versionId: string; version: number; content: TemplateContent }
export interface SignerAccount { id: string; displayName: string; status: string }
export interface SignerRow { id: string; userId: string; displayName: string; roleLabel: string; status: "pending" | "signed" | "declined"; typedName?: string; signedAt?: string }
export interface DocSummary {
  id: string; listingId: string; listingTitle: string; ownerUserId: string; title: string; status: DocStatus; bodySha256: string; provider: SigningProvider; retryOf?: string; envelopeId?: string;
  createdAt: string; sentAt?: string; closedAt?: string; signers: SignerRow[];
}
export interface SigningDoc extends DocSummary { templateVersionId: string; clauses: RenderedClause[]; fieldValues: Record<string, string> }
export interface SigningEvent { id: number; signerId?: string; actorName: string; eventType: EventType; ip?: string; detail: Record<string, unknown>; occurredAt: string }
export interface NewEvent { documentId: string; signerId?: string; actorUserId: string; eventType: EventType; bodySha256: string; ip?: string | undefined; userAgent?: string | undefined; detail?: Record<string, unknown>; at: string }
export interface NewDocument { id: string; listingId: string; templateVersionId: string; createdBy: string; title: string; clauses: RenderedClause[]; fieldValues: Record<string, string>; bodySha256: string; at: string; provider?: SigningProvider; retryOf?: string }
export interface NewSigner { id: string; userId: string; roleLabel: string }

export interface SigningRepository {
  publishedTemplates(): Promise<PublishedTemplate[]>;
  listing(id: string): Promise<SigningListing | undefined>;
  accountByEmail(email: string): Promise<SignerAccount | undefined>;
  /** Email address of each signer of the document, by signer id. For the signed PDF only; never sent in JSON. */
  signerEmails(documentId: string): Promise<Record<string, string>>;
  /** Inserts the document, its signers and the "created" event together. */
  insertDocument(doc: NewDocument, signers: NewSigner[], event: NewEvent): Promise<void>;
  document(id: string): Promise<SigningDoc | undefined>;
  documentsForListing(listingId: string): Promise<DocSummary[]>;
  /** Documents the user signs, plus (for owners) documents on their own listings. */
  documentsForUser(userId: string): Promise<DocSummary[]>;
  events(documentId: string): Promise<SigningEvent[]>;
  appendEvent(e: NewEvent): Promise<void>;
  /** Moves the status only while it is one of `from`. Returns false when nothing moved. */
  setStatus(id: string, from: readonly DocStatus[], to: DocStatus, at: string): Promise<boolean>;
  /** Signers with the email on their account and, once sent through DocuSign, their recipient id. Server-side only: emails are never shown to other signers. */
  signerContacts(documentId: string): Promise<SignerContact[]>;
  /** Records the DocuSign envelope and each signer's recipient id, once. Returns false if the document already has an envelope. */
  setEnvelope(documentId: string, envelopeId: string, recipients: { signerId: string; recipientId: string }[]): Promise<boolean>;
  documentByEnvelope(envelopeId: string): Promise<SigningDoc | undefined>;
  /** Stores the signed copies (once per kind) and adds the signed PDF to the listing's document history. */
  addArtifacts(documentId: string, items: NewArtifact[], at: string): Promise<void>;
  artifacts(documentId: string): Promise<ArtifactRow[]>;
  artifactKey(documentId: string, kind: ArtifactKind): Promise<string | undefined>;
  /** Marks a signer signed or declined only while still pending. Returns false when nothing changed. */
  decide(signerId: string, decision: "signed" | "declined", typedName: string | null, at: string): Promise<boolean>;
  /** Runs `fn` in one transaction with the document row locked, so two signers cannot both miss the other's signature. */
  atomic<T>(documentId: string | null, fn: (r: SigningRepository) => Promise<T>): Promise<T>;
}

export interface Ids { newId: () => string; now: () => string }
export interface RequestContext { ip?: string | undefined; userAgent?: string | undefined; /** When the signer last passed the second sign-in step (ISO time); recorded with the signature. */ mfaVerifiedAt?: string | undefined }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const NOT_FOUND = fail("not_found", "Document not found.");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export interface TemplateSummary { key: string; title: string; category: TemplateCategory; version: number; fields: TemplateContent["fields"] }

export async function listTemplates(repo: SigningRepository, actor: Actor): Promise<Result<TemplateSummary[]>> {
  if (actor.userType !== "owner" && actor.userType !== "agent") return fail("forbidden", "Only owners and agents can generate documents.");
  return { ok: true, value: (await repo.publishedTemplates()).map(t => ({ key: t.key, title: t.title, category: t.category, version: t.version, fields: t.content.fields })) };
}

/** The listing's owner generates a draft from a published template. Body: { templateKey, values, signers: [{ email, roleLabel }] }. */
/**
 * Draft a document. A signer address with no active account fails with SIGNER_UNAVAILABLE (and says nothing about which address), so the
 * route can answer exactly as for a success and the endpoint does not reveal which addresses are registered (security review 2026-10).
 */
export const SIGNER_UNAVAILABLE = "One or more signers cannot be added.";
export async function generateDocument(repo: SigningRepository, actor: Actor, listingId: string, body: unknown, ids: Ids, ctx: RequestContext = {}, opts: { provider?: SigningProvider } = {}): Promise<Result<SigningDoc>> {
  if (!UUID_RE.test(listingId)) return fail("not_found", "Listing not found.");
  const listing = await repo.listing(listingId);
  if (!listing || listing.ownerUserId !== actor.userId) return fail("not_found", "Listing not found.");
  if (!isObj(body) || typeof body["templateKey"] !== "string") return fail("invalid", "Choose a template.");
  const tpl = (await repo.publishedTemplates()).find(t => t.key === body["templateKey"]);
  if (!tpl) return fail("not_found", "That template is not available.");
  const content = parseStoredContent(tpl.content);
  if (!content) return fail("unavailable", "That template needs attention from staff before it can be used.");
  const values = parseFieldValues(content, body["values"]);
  if (!values.ok) return fail("invalid", values.errors.join(" "));

  const rawSigners = body["signers"];
  if (!Array.isArray(rawSigners) || rawSigners.length < 1 || rawSigners.length > MAX_SIGNERS) return fail("invalid", `Add between 1 and ${MAX_SIGNERS} signers.`);
  const signers: NewSigner[] = [];
  const seen = new Set<string>();
  const seenEmails = new Set<string>();
  let unresolved = false;
  for (const s of rawSigners) {
    const email = isObj(s) && typeof s["email"] === "string" ? s["email"].trim().toLowerCase() : "";
    const roleLabel = isObj(s) && typeof s["roleLabel"] === "string" ? s["roleLabel"].trim() : "";
    if (!EMAIL_RE.test(email)) return fail("invalid", "Each signer needs a valid email address.");
    if (roleLabel.length < 2 || roleLabel.length > 60) return fail("invalid", "Each signer needs a role, for example Buyer or Agent.");
    // Duplicates are caught by address before any lookup, so the answer is the same whether or not the address has an account.
    if (seenEmails.has(email)) return fail("invalid", "The same person is listed twice.");
    seenEmails.add(email);
    const acct = await repo.accountByEmail(email);
    if (!acct || acct.status !== "active") { unresolved = true; continue; }
    if (seen.has(acct.id)) return fail("invalid", "The same person is listed twice.");
    seen.add(acct.id);
    signers.push({ id: ids.newId(), userId: acct.id, roleLabel });
  }

  if (unresolved) return fail("invalid", SIGNER_UNAVAILABLE);
  const at = ids.now();
  const builtins: Builtins = { listing_title: listing.title, listing_address: listing.address, jurisdiction: listing.jurisdiction, generated_date: formatDate(at), owner_name: listing.ownerName };
  const clauses = renderClauses(content, values.value, builtins);
  const title = `${tpl.title} - ${listing.title}`.slice(0, 200);
  const doc: NewDocument = { id: ids.newId(), listingId, templateVersionId: tpl.versionId, createdBy: actor.userId, title, clauses, fieldValues: values.value, bodySha256: documentHash(title, clauses), at, provider: opts.provider ?? "builtin" };
  await repo.insertDocument(doc, signers, { documentId: doc.id, actorUserId: actor.userId, eventType: "created", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { templateKey: tpl.key, templateVersion: tpl.version }, at });
  const saved = await repo.document(doc.id);
  return saved ? { ok: true, value: saved } : fail("unavailable", "Could not save the document.");
}

const asOwner = async (repo: SigningRepository, actor: Actor, id: string): Promise<Result<SigningDoc>> => {
  const doc = UUID_RE.test(id) ? await repo.document(id) : undefined;
  return doc && doc.ownerUserId === actor.userId ? { ok: true, value: doc } : NOT_FOUND;
};

/** Owner sends a draft for signature. Nothing can be edited afterwards; to change the text, cancel and generate a new document. */
export async function sendDocument(repo: SigningRepository, actor: Actor, id: string, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const d = await asOwner(repo, actor, id);
  if (!d.ok) return d;
  if (d.value.provider === "docusign") return fail("conflict", "This document is signed through DocuSign; send it from there.");
  return repo.atomic(id, async tx => {
    const at = ids.now();
    if (!(await tx.setStatus(id, ["draft"], "out_for_signature", at))) return fail("conflict", "Only a draft can be sent.");
    await tx.appendEvent({ documentId: id, actorUserId: actor.userId, eventType: "sent", bodySha256: d.value.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { signers: d.value.signers.length }, at });
    return { ok: true as const, value: (await tx.document(id))! };
  });
}

export async function cancelDocument(repo: SigningRepository, actor: Actor, id: string, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const d = await asOwner(repo, actor, id);
  if (!d.ok) return d;
  return repo.atomic(id, async tx => {
    const at = ids.now();
    if (!(await tx.setStatus(id, ["draft", "out_for_signature"], "cancelled", at))) return fail("conflict", "This document is already closed.");
    await tx.appendEvent({ documentId: id, actorUserId: actor.userId, eventType: "cancelled", bodySha256: d.value.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, at });
    return { ok: true as const, value: (await tx.document(id))! };
  });
}

export interface DocView { document: SigningDoc; viewer: { role: "owner" | "signer"; signerId?: string; signerStatus?: SignerRow["status"]; canSign: boolean }; events: SigningEvent[] }

const roleOf = (doc: SigningDoc, actor: Actor): { role: "owner" | "signer"; signer?: SignerRow } | undefined => {
  const signer = doc.signers.find(s => s.userId === actor.userId);
  if (doc.ownerUserId === actor.userId) return signer ? { role: "owner", signer } : { role: "owner" };
  // A signer sees nothing until the owner sends it.
  return signer && doc.status !== "draft" ? { role: "signer", signer } : undefined;
};

/** The owner or a signer reads the document and its audit trail. A signer's first look is recorded as "viewed". */
export async function viewDocument(repo: SigningRepository, actor: Actor, id: string, ids: Ids, ctx: RequestContext = {}): Promise<Result<DocView>> {
  const doc = UUID_RE.test(id) ? await repo.document(id) : undefined;
  const who = doc && roleOf(doc, actor);
  if (!doc || !who) return NOT_FOUND;
  const signer = who.signer;
  let events = await repo.events(id);
  let logged = false;
  if (signer && signer.status === "pending" && doc.status === "out_for_signature" && !events.some(e => e.eventType === "viewed" && e.signerId === signer.id)) {
    await repo.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "viewed", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { viewReason: "sign-attempt" satisfies ViewReason }, at: ids.now() });
    logged = true;
  }
  if (who.role === "owner") {
    const now = Date.parse(ids.now());
    const last = events.filter(e => e.eventType === "owner_viewed").map(e => Date.parse(e.occurredAt)).reduce((a, b) => Math.max(a, b), 0);
    if (!(now - last < OWNER_VIEW_LOG_GAP_MS)) {
      await repo.appendEvent({ documentId: id, actorUserId: actor.userId, eventType: "owner_viewed", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { viewReason: "owner-check" satisfies ViewReason }, at: ids.now() });
      logged = true;
    }
  }
  if (logged) events = await repo.events(id);
  return { ok: true, value: {
    document: doc,
    viewer: { role: who.role, ...(signer ? { signerId: signer.id, signerStatus: signer.status } : {}), canSign: !!signer && signer.status === "pending" && doc.status === "out_for_signature" },
    events
  } };
}

/** The approved plain-English explanation of one clause. A signer's request is logged so the audit trail shows what was explained. */
export async function explainClause(repo: SigningRepository, actor: Actor, id: string, clauseId: unknown, ids: Ids, ctx: RequestContext = {}): Promise<Result<{ clauseId: string; heading: string; explanation: string; disclaimer: string }>> {
  const doc = UUID_RE.test(id) ? await repo.document(id) : undefined;
  const who = doc && roleOf(doc, actor);
  if (!doc || !who) return NOT_FOUND;
  const clause = typeof clauseId === "string" ? doc.clauses.find(c => c.id === clauseId) : undefined;
  if (!clause) return fail("invalid", "Choose a clause from this document.");
  if (who.signer && doc.status === "out_for_signature") {
    await repo.appendEvent({ documentId: id, signerId: who.signer.id, actorUserId: actor.userId, eventType: "explained", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { clauseId: clause.id }, at: ids.now() });
  }
  return { ok: true, value: { clauseId: clause.id, heading: clause.heading, explanation: clause.explanation, disclaimer: EXPLAIN_DISCLAIMER } };
}

/** Body: { typedName, consent: true }. The typed name must match the name on the signer's own account, and they must have opened the document first. */
export async function signDocument(repo: SigningRepository, actor: Actor, id: string, body: unknown, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const pre = UUID_RE.test(id) ? await repo.document(id) : undefined;
  const signer = pre && pre.status !== "draft" ? pre.signers.find(s => s.userId === actor.userId) : undefined;
  if (!pre || !signer) return NOT_FOUND;
  // Every refusal from here on is written to the audit trail (who, when, from where, and which check failed). Nothing typed is stored.
  const refuse = async (r: SigningRepository, reason: string, f: Failure): Promise<Failure> => {
    await r.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "sign_failed", bodySha256: pre.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { viewReason: "sign-attempt" satisfies ViewReason, reason }, at: ids.now() });
    return f;
  };
  if (pre.provider === "docusign") return refuse(repo, "wrong_provider", fail("conflict", "Sign this document in DocuSign: use the Sign with DocuSign button."));
  if (pre.status !== "out_for_signature") return refuse(repo, "closed", fail("conflict", "This document is no longer open for signing."));
  if (signer.status !== "pending") return refuse(repo, "already_responded", fail("conflict", "You have already responded to this document."));
  if (!isObj(body) || body["consent"] !== true) return refuse(repo, "no_consent", fail("invalid", "Tick the box to agree to sign electronically."));
  const typed = typeof body["typedName"] === "string" ? body["typedName"] : "";
  if (!sameName(typed, signer.displayName)) return refuse(repo, "name_mismatch", fail("invalid", "Type your full name exactly as it appears on your account."));
  if (!(await repo.events(id)).some(e => e.eventType === "viewed" && e.signerId === signer.id)) return refuse(repo, "not_opened", fail("conflict", "Open and read the document before signing."));

  return repo.atomic(id, async tx => {
    const doc = await tx.document(id);
    const at = ids.now();
    if (!doc || doc.status !== "out_for_signature") return refuse(tx, "closed", fail("conflict", "This document is no longer open for signing."));
    if (!(await tx.decide(signer.id, "signed", typed.trim().replace(/\s+/g, " "), at))) return refuse(tx, "already_responded", fail("conflict", "You have already responded to this document."));
    await tx.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "signed", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { role: signer.roleLabel, consent: "electronic signature", ...(ctx.mfaVerifiedAt ? { mfaVerifiedAt: ctx.mfaVerifiedAt } : {}) }, at });
    const after = (await tx.document(id))!;
    if (after.signers.every(s => s.status === "signed") && (await tx.setStatus(id, ["out_for_signature"], "completed", at))) {
      await tx.appendEvent({ documentId: id, actorUserId: actor.userId, eventType: "completed", bodySha256: doc.bodySha256, at });
    }
    return { ok: true as const, value: (await tx.document(id))! };
  });
}

/** Data for the signed PDF. Only the owner and the signers, and only once everyone has signed. Anyone else gets 404. */
export async function signedCopyData(repo: SigningRepository, actor: Actor, id: string): Promise<Result<{ document: SigningDoc; events: SigningEvent[]; emails: Record<string, string> }>> {
  const doc = UUID_RE.test(id) ? await repo.document(id) : undefined;
  if (!doc || !roleOf(doc, actor)) return NOT_FOUND;
  if (doc.status !== "completed") return fail("conflict", "A signed copy is available once everyone has signed.");
  // DocuSign documents carry DocuSign's own signed PDF and certificate (the files route); a copy built here would have no signatures.
  if (doc.provider === "docusign") return fail("conflict", "Download the signed copy saved from DocuSign.");
  return { ok: true, value: { document: doc, events: await repo.events(id), emails: await repo.signerEmails(id) } };
}

/**
 * Support staff reading a sent document (never a draft) to help with a dispute. The caller has already checked the staff permission
 * and writes the platform audit entry; the reason must be one of VIEW_REASONS (staff may only give "dispute-support").
 */
export async function supportViewDocument(repo: SigningRepository, id: string): Promise<Result<{ document: SigningDoc; events: SigningEvent[] }>> {
  const doc = UUID_RE.test(id) ? await repo.document(id) : undefined;
  if (!doc || doc.status === "draft") return NOT_FOUND;
  return { ok: true, value: { document: doc, events: await repo.events(id) } };
}

/** A signer declines. That closes the whole document; the owner can generate a new one. Body: { reason? }. */
export async function declineDocument(repo: SigningRepository, actor: Actor, id: string, body: unknown, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const pre = UUID_RE.test(id) ? await repo.document(id) : undefined;
  const signer = pre && pre.status !== "draft" ? pre.signers.find(s => s.userId === actor.userId) : undefined;
  if (!pre || !signer) return NOT_FOUND;
  if (pre.provider === "docusign") return fail("conflict", "Decline this document in DocuSign, on the signing page.");
  const reason = isObj(body) && typeof body["reason"] === "string" ? body["reason"].trim().slice(0, 500) : "";
  return repo.atomic(id, async tx => {
    const at = ids.now();
    if (!(await tx.setStatus(id, ["out_for_signature"], "declined", at))) return fail("conflict", "This document is no longer open for signing.");
    if (!(await tx.decide(signer.id, "declined", null, at))) return fail("conflict", "You have already responded to this document.");
    await tx.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "declined", bodySha256: pre.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: reason ? { reason } : {}, at });
    return { ok: true as const, value: (await tx.document(id))! };
  });
}

export async function documentsForListing(repo: SigningRepository, actor: Actor, listingId: string): Promise<Result<DocSummary[]>> {
  const listing = UUID_RE.test(listingId) ? await repo.listing(listingId) : undefined;
  if (!listing || listing.ownerUserId !== actor.userId) return fail("not_found", "Listing not found.");
  return { ok: true, value: await repo.documentsForListing(listingId) };
}

/** Everything the signed-in person has to sign or has sent. Drafts are only listed to the owner who made them. */
export async function myDocuments(repo: SigningRepository, actor: Actor): Promise<Result<DocSummary[]>> {
  const all = await repo.documentsForUser(actor.userId);
  return { ok: true, value: all.filter(d => d.ownerUserId === actor.userId || d.status !== "draft") };
}

/** Test and local-dev repository. Mirrors the Postgres behaviour. */
export function createInMemorySigningRepository(seed: { listings: SigningListing[]; accounts: (SignerAccount & { email: string })[]; templates: PublishedTemplate[] }): SigningRepository & { eventsRaw: NewEvent[] } {
  const docs = new Map<string, SigningDoc>();
  const evs: NewEvent[] = [];
  const recips = new Map<string, string>();
  const arts: (NewArtifact & ArtifactRow & { documentId: string })[] = [];
  let seq = 0;
  const nameOf = (id: string) => seed.accounts.find(a => a.id === id)?.displayName ?? seed.listings.find(l => l.ownerUserId === id)?.ownerName ?? "Unknown";
  const summary = (d: SigningDoc): DocSummary => { const { clauses: _c, templateVersionId: _t, fieldValues: _f, ...s } = d; void _c; void _t; void _f; return structuredClone(s); };
  const repo: SigningRepository & { eventsRaw: NewEvent[] } = {
    eventsRaw: evs,
    publishedTemplates: async () => structuredClone(seed.templates),
    listing: async id => seed.listings.find(l => l.id === id),
    accountByEmail: async email => { const a = seed.accounts.find(x => x.email === email); return a ? { id: a.id, displayName: a.displayName, status: a.status } : undefined; },
    signerEmails: async id => Object.fromEntries((docs.get(id)?.signers ?? []).map(s => [s.id, seed.accounts.find(a => a.id === s.userId)?.email ?? ""])),
    insertDocument: async (d, signers, event) => {
      const l = seed.listings.find(x => x.id === d.listingId)!;
      docs.set(d.id, { id: d.id, listingId: d.listingId, listingTitle: l.title, ownerUserId: l.ownerUserId, templateVersionId: d.templateVersionId, title: d.title, clauses: d.clauses, status: "draft",
        bodySha256: d.bodySha256, createdAt: d.at, provider: d.provider ?? "builtin", fieldValues: d.fieldValues, ...(d.retryOf ? { retryOf: d.retryOf } : {}), signers: signers.map(s => ({ id: s.id, userId: s.userId, displayName: nameOf(s.userId), roleLabel: s.roleLabel, status: "pending" as const })) });
      evs.push(event);
    },
    document: async id => { const d = docs.get(id); return d ? structuredClone(d) : undefined; },
    documentsForListing: async listingId => [...docs.values()].filter(d => d.listingId === listingId).map(summary),
    documentsForUser: async userId => [...docs.values()].filter(d => d.ownerUserId === userId || d.signers.some(s => s.userId === userId)).map(summary),
    events: async id => evs.filter(e => e.documentId === id).map(e => ({ id: ++seq, ...(e.signerId ? { signerId: e.signerId } : {}), actorName: nameOf(e.actorUserId), eventType: e.eventType, ...(e.ip ? { ip: e.ip } : {}), detail: e.detail ?? {}, occurredAt: e.at })),
    appendEvent: async e => { evs.push(e); },
    setStatus: async (id, from, to, at) => {
      const d = docs.get(id);
      if (!d || !from.includes(d.status)) return false;
      d.status = to;
      if (to === "out_for_signature") d.sentAt = at; else d.closedAt = at;
      return true;
    },
    decide: async (signerId, decision, typedName, at) => {
      for (const d of docs.values()) {
        const s = d.signers.find(x => x.id === signerId);
        if (s) { if (s.status !== "pending") return false; s.status = decision; if (typedName) { s.typedName = typedName; s.signedAt = at; } return true; }
      }
      return false;
    },
    signerContacts: async id => {
      const d = docs.get(id);
      return (d?.signers ?? []).map(s => ({ signerId: s.id, userId: s.userId, name: s.displayName, email: seed.accounts.find(a => a.id === s.userId)?.email ?? "", roleLabel: s.roleLabel, ...(recips.get(s.id) ? { recipientId: recips.get(s.id)! } : {}) }));
    },
    setEnvelope: async (id, envelopeId, recipients) => {
      const d = docs.get(id);
      if (!d || d.envelopeId) return false;
      d.envelopeId = envelopeId;
      for (const r of recipients) recips.set(r.signerId, r.recipientId);
      return true;
    },
    documentByEnvelope: async envelopeId => { const d = [...docs.values()].find(x => x.envelopeId === envelopeId); return d ? structuredClone(d) : undefined; },
    addArtifacts: async (id, items, at) => {
      for (const i of items) if (!arts.some(a => a.documentId === id && a.kind === i.kind)) arts.push({ documentId: id, ...i, id: `art-${arts.length + 1}`, createdAt: at });
    },
    artifacts: async id => arts.filter(a => a.documentId === id).map(a => ({ id: a.id, kind: a.kind, sha256: a.sha256, sizeBytes: a.sizeBytes, createdAt: a.createdAt })),
    artifactKey: async (id, kind) => arts.find(a => a.documentId === id && a.kind === kind)?.storageKey,
    atomic: async (_id, fn) => fn(repo)
  };
  return repo;
}
