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
export type EventType = "created" | "sent" | "viewed" | "explained" | "signed" | "declined" | "completed" | "cancelled";

export interface SigningListing { id: string; ownerUserId: string; ownerName: string; title: string; address: string; jurisdiction: string }
export interface PublishedTemplate { templateId: string; key: string; title: string; category: TemplateCategory; versionId: string; version: number; content: TemplateContent }
export interface SignerAccount { id: string; displayName: string; status: string }
export interface SignerRow { id: string; userId: string; displayName: string; roleLabel: string; status: "pending" | "signed" | "declined"; typedName?: string; signedAt?: string }
export interface DocSummary {
  id: string; listingId: string; listingTitle: string; ownerUserId: string; title: string; status: DocStatus; bodySha256: string;
  createdAt: string; sentAt?: string; closedAt?: string; signers: SignerRow[];
}
export interface SigningDoc extends DocSummary { templateVersionId: string; clauses: RenderedClause[] }
export interface SigningEvent { id: number; signerId?: string; actorName: string; eventType: EventType; ip?: string; detail: Record<string, unknown>; occurredAt: string }
export interface NewEvent { documentId: string; signerId?: string; actorUserId: string; eventType: EventType; bodySha256: string; ip?: string | undefined; userAgent?: string | undefined; detail?: Record<string, unknown>; at: string }
export interface NewDocument { id: string; listingId: string; templateVersionId: string; createdBy: string; title: string; clauses: RenderedClause[]; fieldValues: Record<string, string>; bodySha256: string; at: string }
export interface NewSigner { id: string; userId: string; roleLabel: string }

export interface SigningRepository {
  publishedTemplates(): Promise<PublishedTemplate[]>;
  listing(id: string): Promise<SigningListing | undefined>;
  accountByEmail(email: string): Promise<SignerAccount | undefined>;
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
export async function generateDocument(repo: SigningRepository, actor: Actor, listingId: string, body: unknown, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
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
  for (const s of rawSigners) {
    const email = isObj(s) && typeof s["email"] === "string" ? s["email"].trim().toLowerCase() : "";
    const roleLabel = isObj(s) && typeof s["roleLabel"] === "string" ? s["roleLabel"].trim() : "";
    if (!EMAIL_RE.test(email)) return fail("invalid", "Each signer needs a valid email address.");
    if (roleLabel.length < 2 || roleLabel.length > 60) return fail("invalid", "Each signer needs a role, for example Buyer or Agent.");
    const acct = await repo.accountByEmail(email);
    if (!acct || acct.status !== "active") return fail("invalid", `${email} needs an active account on the platform before they can sign. Ask them to sign up first.`);
    if (seen.has(acct.id)) return fail("invalid", `${email} is listed twice.`);
    seen.add(acct.id);
    signers.push({ id: ids.newId(), userId: acct.id, roleLabel });
  }

  const at = ids.now();
  const builtins: Builtins = { listing_title: listing.title, listing_address: listing.address, jurisdiction: listing.jurisdiction, generated_date: formatDate(at), owner_name: listing.ownerName };
  const clauses = renderClauses(content, values.value, builtins);
  const title = `${tpl.title} - ${listing.title}`.slice(0, 200);
  const doc: NewDocument = { id: ids.newId(), listingId, templateVersionId: tpl.versionId, createdBy: actor.userId, title, clauses, fieldValues: values.value, bodySha256: documentHash(title, clauses), at };
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
  if (signer && signer.status === "pending" && doc.status === "out_for_signature") {
    const seen = (await repo.events(id)).some(e => e.eventType === "viewed" && e.signerId === signer.id);
    if (!seen) await repo.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "viewed", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, at: ids.now() });
  }
  return { ok: true, value: {
    document: doc,
    viewer: { role: who.role, ...(signer ? { signerId: signer.id, signerStatus: signer.status } : {}), canSign: !!signer && signer.status === "pending" && doc.status === "out_for_signature" },
    events: await repo.events(id)
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
  if (pre.status !== "out_for_signature") return fail("conflict", "This document is no longer open for signing.");
  if (signer.status !== "pending") return fail("conflict", "You have already responded to this document.");
  if (!isObj(body) || body["consent"] !== true) return fail("invalid", "Tick the box to agree to sign electronically.");
  const typed = typeof body["typedName"] === "string" ? body["typedName"] : "";
  if (!sameName(typed, signer.displayName)) return fail("invalid", "Type your full name exactly as it appears on your account.");
  if (!(await repo.events(id)).some(e => e.eventType === "viewed" && e.signerId === signer.id)) return fail("conflict", "Open and read the document before signing.");

  return repo.atomic(id, async tx => {
    const doc = await tx.document(id);
    const at = ids.now();
    if (!doc || doc.status !== "out_for_signature") return fail("conflict", "This document is no longer open for signing.");
    if (!(await tx.decide(signer.id, "signed", typed.trim().replace(/\s+/g, " "), at))) return fail("conflict", "You have already responded to this document.");
    await tx.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "signed", bodySha256: doc.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { role: signer.roleLabel, consent: "electronic signature", ...(ctx.mfaVerifiedAt ? { mfaVerifiedAt: ctx.mfaVerifiedAt } : {}) }, at });
    const after = (await tx.document(id))!;
    if (after.signers.every(s => s.status === "signed") && (await tx.setStatus(id, ["out_for_signature"], "completed", at))) {
      await tx.appendEvent({ documentId: id, actorUserId: actor.userId, eventType: "completed", bodySha256: doc.bodySha256, at });
    }
    return { ok: true as const, value: (await tx.document(id))! };
  });
}

/** A signer declines. That closes the whole document; the owner can generate a new one. Body: { reason? }. */
export async function declineDocument(repo: SigningRepository, actor: Actor, id: string, body: unknown, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const pre = UUID_RE.test(id) ? await repo.document(id) : undefined;
  const signer = pre && pre.status !== "draft" ? pre.signers.find(s => s.userId === actor.userId) : undefined;
  if (!pre || !signer) return NOT_FOUND;
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
  let seq = 0;
  const nameOf = (id: string) => seed.accounts.find(a => a.id === id)?.displayName ?? seed.listings.find(l => l.ownerUserId === id)?.ownerName ?? "Unknown";
  const summary = (d: SigningDoc): DocSummary => { const { clauses: _c, templateVersionId: _t, ...s } = d; void _c; void _t; return structuredClone(s); };
  const repo: SigningRepository & { eventsRaw: NewEvent[] } = {
    eventsRaw: evs,
    publishedTemplates: async () => structuredClone(seed.templates),
    listing: async id => seed.listings.find(l => l.id === id),
    accountByEmail: async email => { const a = seed.accounts.find(x => x.email === email); return a ? { id: a.id, displayName: a.displayName, status: a.status } : undefined; },
    insertDocument: async (d, signers, event) => {
      const l = seed.listings.find(x => x.id === d.listingId)!;
      docs.set(d.id, { id: d.id, listingId: d.listingId, listingTitle: l.title, ownerUserId: l.ownerUserId, templateVersionId: d.templateVersionId, title: d.title, clauses: d.clauses, status: "draft",
        bodySha256: d.bodySha256, createdAt: d.at, signers: signers.map(s => ({ id: s.id, userId: s.userId, displayName: nameOf(s.userId), roleLabel: s.roleLabel, status: "pending" as const })) });
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
    atomic: async (_id, fn) => fn(repo)
  };
  return repo;
}
