import { createHash, randomUUID } from "node:crypto";
import type { EsignProvider } from "../adapters/docusign";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { buildEnvelope, renderDocumentHtml, type EnvelopeSigner, type EnvelopeUpdate } from "./docusign";
import type { Actor, Failure, Result } from "./listing-service";
import { cancelDocument, type ArtifactKind, type Ids, type NewArtifact, type RequestContext, type SigningDoc, type SigningRepository } from "./signing-service";

/**
 * Signing through DocuSign. The document text and its SHA-256 are frozen by the platform exactly as for the built-in flow; DocuSign
 * collects the signatures (embedded signing: each signer is sent to DocuSign from their own signed-in account), and its webhooks and
 * status checks drive our status and audit trail. When all have signed, DocuSign's signed PDF and certificate are stored in our own
 * file storage and the signed PDF is added to the listing's document history. The built-in flow in signing-service.ts is untouched
 * and still owns every document whose provider is "builtin".
 */
export interface EsignDeps {
  repo: SigningRepository;
  esign: EsignProvider;
  storage: Pick<ObjectStoragePort, "configured" | "put">;
  ids: Ids;
  /** Public https address of this site, no trailing slash. Return links and the webhook address are built from it. */
  appUrl: string;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = fail("not_found", "Document not found.");
const UNAVAILABLE = fail("unavailable", "DocuSign could not be reached just now. Nothing was changed; please try again in a moment.");
const CLOSED = ["completed", "declined", "cancelled"] as const;

const load = async (repo: SigningRepository, id: string): Promise<SigningDoc | undefined> => (UUID_RE.test(id) ? repo.document(id) : undefined);

/** Owner sends a draft to DocuSign. The envelope is created first; only when that works does the document become "out for signature". */
export async function sendViaDocusign(deps: EsignDeps, actor: Actor, id: string, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const { repo, esign, ids } = deps;
  const d = await load(repo, id);
  if (!d || d.ownerUserId !== actor.userId) return NOT_FOUND;
  if (d.provider !== "docusign") return fail("conflict", "This document is signed on the platform, not through DocuSign.");
  if (d.status !== "draft") return fail("conflict", "Only a draft can be sent.");
  const contacts = await repo.signerContacts(id);
  if (contacts.length === 0 || contacts.some(c => !c.email)) return fail("invalid", "Every signer needs an email address on their account.");
  const signers: EnvelopeSigner[] = contacts.map((c, i) => ({ recipientId: String(i + 1), clientUserId: c.signerId, name: c.name, email: c.email, roleLabel: c.roleLabel, routingOrder: 1 }));
  const html = renderDocumentHtml({ title: d.title, listingTitle: d.listingTitle, bodySha256: d.bodySha256, clauses: d.clauses, signers });
  const definition = buildEnvelope({ subject: `Please sign: ${d.title}`, title: d.title, html, signers, ...(deps.appUrl.startsWith("https://") ? { webhookUrl: `${deps.appUrl}/api/webhooks/docusign` } : {}) });

  let envelopeId: string;
  try { envelopeId = (await esign.createEnvelope(definition)).envelopeId; } catch { return UNAVAILABLE; }
  try {
    return await repo.atomic(id, async tx => {
      const at = ids.now();
      if (!(await tx.setStatus(id, ["draft"], "out_for_signature", at))) throw new Error("not a draft");
      if (!(await tx.setEnvelope(id, envelopeId, signers.map(s => ({ signerId: s.clientUserId, recipientId: s.recipientId }))))) throw new Error("envelope already set");
      await tx.appendEvent({ documentId: id, actorUserId: actor.userId, eventType: "sent", bodySha256: d.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { provider: "docusign", envelopeId, signers: signers.length }, at });
      return { ok: true as const, value: (await tx.document(id))! };
    });
  } catch {
    // Our side failed after DocuSign accepted it: void the envelope so nobody can sign a document we do not track.
    await esign.voidEnvelope(envelopeId, "Could not be recorded by the platform").catch(() => undefined);
    return fail("conflict", "Only a draft can be sent.");
  }
}

/** A pending signer asks for the DocuSign page. The link is one-time and bound to that signer; we never hand it to anyone else. */
export async function docusignSigningLink(deps: EsignDeps, actor: Actor, id: string, ctx: RequestContext = {}): Promise<Result<{ url: string }>> {
  const { repo, esign, ids } = deps;
  const d = await load(repo, id);
  const signer = d && d.status !== "draft" ? d.signers.find(s => s.userId === actor.userId) : undefined;
  if (!d || !signer) return NOT_FOUND;
  if (d.provider !== "docusign" || !d.envelopeId) return fail("conflict", "This document is signed on the platform, not through DocuSign.");
  if (d.status !== "out_for_signature") return fail("conflict", "This document is no longer open for signing.");
  if (signer.status !== "pending") return fail("conflict", "You have already responded to this document.");
  const me = (await repo.signerContacts(id)).find(c => c.signerId === signer.id);
  if (!me?.email) return fail("invalid", "Your account needs an email address to sign.");
  let url: string;
  try { url = await esign.recipientView(d.envelopeId, { clientUserId: signer.id, name: me.name, email: me.email, returnUrl: `${deps.appUrl}/signing/${id}?docusign=return` }); } catch { return UNAVAILABLE; }
  if (!(await repo.events(id)).some(e => e.eventType === "viewed" && e.signerId === signer.id)) {
    await repo.appendEvent({ documentId: id, signerId: signer.id, actorUserId: actor.userId, eventType: "viewed", bodySha256: d.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { source: "docusign", step: "opened_signing_page" }, at: ids.now() });
  }
  return { ok: true, value: { url } };
}

/** Cancel: a DocuSign envelope is voided first (so the signing page stops working), then the document is closed as for any provider. */
export async function cancelWithProvider(deps: EsignDeps | undefined, repo: SigningRepository, actor: Actor, id: string, ids: Ids, ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const d = await load(repo, id);
  if (d && d.ownerUserId === actor.userId && d.provider === "docusign" && d.envelopeId && d.status === "out_for_signature") {
    if (!deps) return fail("unavailable", "DocuSign is not set up, so this document cannot be cancelled from here yet.");
    try { await deps.esign.voidEnvelope(d.envelopeId, "Cancelled by the owner"); } catch { return UNAVAILABLE; }
  }
  return cancelDocument(repo, actor, id, ids, ctx);
}

/** Applies what DocuSign reports (webhook or status check). Safe to repeat: each step only moves a pending signer or an open document. */
export async function applyEnvelopeUpdate(deps: EsignDeps, update: EnvelopeUpdate): Promise<Result<SigningDoc>> {
  const { repo, ids } = deps;
  const found = await repo.documentByEnvelope(update.envelopeId);
  if (!found) return fail("not_found", "Unknown envelope.");
  const contacts = await repo.signerContacts(found.id);
  const applied = await repo.atomic(found.id, async tx => {
    const cur = await tx.document(found.id);
    if (!cur) return NOT_FOUND;
    if ((CLOSED as readonly string[]).includes(cur.status)) return { ok: true as const, value: cur };
    const at = ids.now();
    const owner = cur.ownerUserId;
    const ev = (eventType: "viewed" | "signed" | "declined" | "completed" | "voided", signer: { id: string; userId: string } | undefined, detail: Record<string, unknown>) =>
      tx.appendEvent({ documentId: cur.id, ...(signer ? { signerId: signer.id } : {}), actorUserId: signer?.userId ?? owner, eventType, bodySha256: cur.bodySha256, detail: { source: "docusign", ...detail }, at });
    let declined = false;
    for (const r of update.recipients) {
      const c = contacts.find(x => x.recipientId === r.recipientId);
      const s = c && cur.signers.find(x => x.id === c.signerId);
      if (!c || !s || s.status !== "pending") continue;
      if (r.state === "completed") {
        if (await tx.decide(s.id, "signed", s.displayName, at)) await ev("signed", s, { role: s.roleLabel, method: "docusign" });
      } else if (r.state === "declined") {
        if (await tx.setStatus(cur.id, ["out_for_signature"], "declined", at) && await tx.decide(s.id, "declined", null, at)) {
          await ev("declined", s, { role: s.roleLabel, ...(r.declinedReason ? { reason: r.declinedReason } : {}) });
          declined = true;
        }
      } else if (!(await tx.events(cur.id)).some(e => e.eventType === "viewed" && e.signerId === s.id)) {
        await ev("viewed", s, { step: "delivered" });
      }
      if (declined) break;
    }
    if (declined) return { ok: true as const, value: (await tx.document(cur.id))! };
    if (update.envelope === "completed") {
      for (const s of (await tx.document(cur.id))!.signers.filter(x => x.status === "pending")) {
        if (await tx.decide(s.id, "signed", s.displayName, at)) await ev("signed", s, { role: s.roleLabel, method: "docusign" });
      }
      if (await tx.setStatus(cur.id, ["out_for_signature"], "completed", at)) await ev("completed", undefined, { envelopeId: update.envelopeId });
    } else if (update.envelope === "declined") {
      if (await tx.setStatus(cur.id, ["out_for_signature"], "declined", at)) await ev("declined", undefined, { reason: "Declined in DocuSign" });
    } else if (update.envelope === "voided") {
      if (await tx.setStatus(cur.id, ["out_for_signature"], "cancelled", at)) await ev("voided", undefined, { reason: "Voided in DocuSign" });
    }
    return { ok: true as const, value: (await tx.document(cur.id))! };
  });
  if (!applied.ok) return applied;
  if (applied.value.status === "completed") {
    const stored = await ensureSignedCopies(deps, applied.value);
    if (!stored.ok) return stored;
  }
  return applied;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Downloads the signed PDF and certificate once and keeps our own copy. Failing here returns an error so the webhook is retried. */
export async function ensureSignedCopies(deps: EsignDeps, doc: SigningDoc): Promise<Result<ArtifactKind[]>> {
  const { repo, esign, storage, ids } = deps;
  if (!doc.envelopeId) return fail("conflict", "No envelope.");
  const have = new Set((await repo.artifacts(doc.id)).map(a => a.kind));
  const want: [ArtifactKind, "combined" | "certificate"][] = [["signed_pdf", "combined"], ["certificate", "certificate"]];
  const missing = want.filter(([k]) => !have.has(k));
  if (missing.length === 0) return { ok: true, value: [...have] };
  if (!storage.configured) return fail("unavailable", "File storage is not configured, so the signed copy could not be kept yet.");
  const items: NewArtifact[] = [];
  try {
    for (const [kind, which] of missing) {
      const bytes = await esign.download(doc.envelopeId, which);
      const storageKey = `signing/${doc.id}/${kind.replace("_", "-")}-${randomUUID().replace(/-/g, "")}`;
      await storage.put(storageKey, bytes, "application/pdf");
      items.push({ kind, storageKey, sha256: sha256(bytes), sizeBytes: bytes.length });
    }
  } catch { return fail("unavailable", "The signed copy could not be downloaded yet."); }
  const at = ids.now();
  await repo.addArtifacts(doc.id, items, at);
  await repo.appendEvent({ documentId: doc.id, actorUserId: doc.ownerUserId, eventType: "stored", bodySha256: doc.bodySha256, detail: { source: "docusign", kinds: items.map(i => i.kind), sha256: Object.fromEntries(items.map(i => [i.kind, i.sha256])) }, at });
  return { ok: true, value: [...have, ...items.map(i => i.kind)] };
}

/** Owner or signer asks the platform to look at DocuSign again. For when a webhook was missed. */
export async function refreshFromDocusign(deps: EsignDeps, actor: Actor, id: string): Promise<Result<SigningDoc>> {
  const d = await load(deps.repo, id);
  const involved = d && (d.ownerUserId === actor.userId || (d.status !== "draft" && d.signers.some(s => s.userId === actor.userId)));
  if (!d || !involved) return NOT_FOUND;
  if (d.provider !== "docusign" || !d.envelopeId) return fail("conflict", "This document is signed on the platform, not through DocuSign.");
  let update: EnvelopeUpdate;
  try { update = await deps.esign.envelopeStatus(d.envelopeId); } catch { return UNAVAILABLE; }
  return applyEnvelopeUpdate(deps, update);
}

/** A declined or cancelled document is closed for good. Retry creates a fresh draft with the identical frozen text, hash and signers. */
export async function retryDocument(repo: SigningRepository, actor: Actor, id: string, ids: Ids, provider: "builtin" | "docusign", ctx: RequestContext = {}): Promise<Result<SigningDoc>> {
  const d = await load(repo, id);
  if (!d || d.ownerUserId !== actor.userId) return NOT_FOUND;
  if (d.status !== "declined" && d.status !== "cancelled") return fail("conflict", "Only a declined or cancelled document can be tried again.");
  const contacts = await repo.signerContacts(id);
  const signers = [];
  for (const c of contacts) {
    const acct = await repo.accountByEmail(c.email.toLowerCase());
    if (!acct || acct.status !== "active") return fail("invalid", `${c.name} no longer has an active account, so this cannot be sent again.`);
    signers.push({ id: ids.newId(), userId: acct.id, roleLabel: c.roleLabel });
  }
  const at = ids.now();
  const newId = ids.newId();
  await repo.insertDocument(
    { id: newId, listingId: d.listingId, templateVersionId: d.templateVersionId, createdBy: actor.userId, title: d.title, clauses: d.clauses, fieldValues: d.fieldValues, bodySha256: d.bodySha256, at, provider, retryOf: d.id },
    signers, { documentId: newId, actorUserId: actor.userId, eventType: "created", bodySha256: d.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { retryOf: d.id }, at });
  await repo.appendEvent({ documentId: d.id, actorUserId: actor.userId, eventType: "retried", bodySha256: d.bodySha256, ip: ctx.ip, userAgent: ctx.userAgent, detail: { newDocumentId: newId }, at });
  const saved = await repo.document(newId);
  return saved ? { ok: true, value: saved } : fail("unavailable", "Could not save the new document.");
}
