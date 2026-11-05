import { randomUUID } from "node:crypto";
import { personaById } from "../domain/assistant-persona";
import type { ChatPersona } from "../domain/chat-assistant";
import { getLivePersona } from "./assistant-persona-db";
import { clientIp } from "./client-ip";
import { parseStoredContent, type RenderedClause } from "../domain/doc-templates";
import type { ArtifactRow, DocStatus, DocSummary, EventType, PublishedTemplate, SignerRow, SigningDoc, SigningEvent, SigningRepository } from "../domain/signing-service";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL text; every value travels as a bound parameter. Writes to one document run in a transaction with the document row
// locked. Nothing here deletes a row (the tables also reject deletes with triggers, db/20261105100000).

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const opt = (v: unknown) => (v == null ? undefined : iso(v));

const DOC_COLS =
  "d.id, d.listing_id, l.title AS listing_title, l.owner_user_id, d.title, d.status, d.body_sha256, d.provider, d.retry_of, d.esign_envelope_id, d.created_at, d.sent_at, d.closed_at";
const DOC_FROM = "FROM signing_document d JOIN property_listing l ON l.id = d.listing_id";
const SIGNERS_SQL =
  "SELECT s.id, s.document_id, s.user_id, u.display_name, s.role_label, s.status, s.typed_name, s.signed_at " +
  "FROM signing_signer s JOIN app_user u ON u.id = s.user_id WHERE s.document_id = ANY($1::uuid[]) ORDER BY s.id";

const toSigner = (r: Record<string, unknown>): SignerRow => ({
  id: String(r["id"]), userId: String(r["user_id"]), displayName: String(r["display_name"]), roleLabel: String(r["role_label"]),
  status: r["status"] as SignerRow["status"], ...(r["typed_name"] ? { typedName: String(r["typed_name"]) } : {}), ...(r["signed_at"] ? { signedAt: iso(r["signed_at"]) } : {})
});

async function summaries(db: Queryable, rows: Record<string, unknown>[]): Promise<DocSummary[]> {
  if (rows.length === 0) return [];
  const signers = (await db.query(SIGNERS_SQL, [rows.map(r => String(r["id"]))])).rows;
  return rows.map(r => ({
    id: String(r["id"]), listingId: String(r["listing_id"]), listingTitle: String(r["listing_title"]), ownerUserId: String(r["owner_user_id"]),
    title: String(r["title"]), status: r["status"] as DocStatus, bodySha256: String(r["body_sha256"]), provider: r["provider"] as DocSummary["provider"], createdAt: iso(r["created_at"]),
    ...(r["retry_of"] ? { retryOf: String(r["retry_of"]) } : {}), ...(r["esign_envelope_id"] ? { envelopeId: String(r["esign_envelope_id"]) } : {}),
    ...(r["sent_at"] ? { sentAt: iso(r["sent_at"]) } : {}), ...(r["closed_at"] ? { closedAt: iso(r["closed_at"]) } : {}),
    signers: signers.filter(s => String(s["document_id"]) === String(r["id"])).map(toSigner)
  }));
}

export function createPgSigningRepository(db: Queryable): SigningRepository {
  const repo: SigningRepository = {
    async publishedTemplates() {
      const res = await db.query(
        `SELECT t.id AS template_id, t.template_key, t.title, t.category, v.id AS version_id, v.version, v.content
           FROM doc_template t
           JOIN LATERAL (SELECT version_id FROM doc_template_publish p WHERE p.template_id = t.id ORDER BY p.id DESC LIMIT 1) p ON true
           JOIN doc_template_version v ON v.id = p.version_id
          ORDER BY t.title`
      );
      const out: PublishedTemplate[] = [];
      for (const r of res.rows) {
        const content = parseStoredContent(r["content"]);
        if (content) out.push({ templateId: String(r["template_id"]), key: String(r["template_key"]), title: String(r["title"]), category: r["category"] as PublishedTemplate["category"], versionId: String(r["version_id"]), version: Number(r["version"]), content });
      }
      return out;
    },
    async listing(id) {
      const r = (await db.query(
        "SELECT l.id, l.owner_user_id, l.title, l.address_text, l.jurisdiction, u.display_name FROM property_listing l JOIN app_user u ON u.id = l.owner_user_id WHERE l.id = $1::uuid", [id]
      )).rows[0];
      return r ? { id: String(r["id"]), ownerUserId: String(r["owner_user_id"]), ownerName: String(r["display_name"]), title: String(r["title"]), address: String(r["address_text"]), jurisdiction: String(r["jurisdiction"]).trim() } : undefined;
    },
    async accountByEmail(email) {
      const r = (await db.query("SELECT id, display_name, status FROM app_user WHERE email = $1::citext", [email])).rows[0];
      return r ? { id: String(r["id"]), displayName: String(r["display_name"]), status: String(r["status"]) } : undefined;
    },
    async signerEmails(documentId) {
      const res = await db.query("SELECT s.id, u.email FROM signing_signer s JOIN app_user u ON u.id = s.user_id WHERE s.document_id = $1::uuid", [documentId]);
      return Object.fromEntries(res.rows.map(r => [String(r["id"]), String(r["email"])]));
    },
    async insertDocument(d, signers, event) {
      await db.query(
        `INSERT INTO signing_document (id, listing_id, template_version_id, created_by, title, rendered, field_values, body_sha256, created_at, provider, retry_of)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7::jsonb,$8,$9::timestamptz,$10,$11::uuid)`,
        [d.id, d.listingId, d.templateVersionId, d.createdBy, d.title, JSON.stringify({ clauses: d.clauses }), JSON.stringify(d.fieldValues), d.bodySha256, d.at, d.provider ?? "builtin", d.retryOf ?? null]
      );
      for (const s of signers) {
        await db.query("INSERT INTO signing_signer (id, document_id, user_id, role_label) VALUES ($1::uuid,$2::uuid,$3::uuid,$4)", [s.id, d.id, s.userId, s.roleLabel]);
      }
      await repo.appendEvent(event);
    },
    async document(id) {
      const r = (await db.query(`SELECT ${DOC_COLS}, d.template_version_id, d.rendered, d.field_values ${DOC_FROM} WHERE d.id = $1::uuid`, [id])).rows[0];
      if (!r) return undefined;
      const [s] = await summaries(db, [r]);
      const clauses = ((r["rendered"] as { clauses?: RenderedClause[] } | null)?.clauses ?? []) as RenderedClause[];
      return { ...s!, templateVersionId: String(r["template_version_id"]), clauses, fieldValues: (r["field_values"] ?? {}) as Record<string, string> } satisfies SigningDoc;
    },
    async documentsForListing(listingId) {
      return summaries(db, (await db.query(`SELECT ${DOC_COLS} ${DOC_FROM} WHERE d.listing_id = $1::uuid ORDER BY d.created_at DESC, d.id`, [listingId])).rows);
    },
    async documentsForUser(userId) {
      return summaries(db, (await db.query(
        `SELECT ${DOC_COLS} ${DOC_FROM} WHERE l.owner_user_id = $1::uuid OR EXISTS (SELECT 1 FROM signing_signer s WHERE s.document_id = d.id AND s.user_id = $1::uuid)
         ORDER BY d.created_at DESC, d.id LIMIT 200`, [userId])).rows);
    },
    async events(documentId) {
      const res = await db.query(
        `SELECT e.id, e.signer_id, u.display_name, e.event_type, e.ip, e.detail, e.occurred_at
           FROM signing_event e JOIN app_user u ON u.id = e.actor_user_id WHERE e.document_id = $1::uuid ORDER BY e.id`, [documentId]);
      return res.rows.map(r => ({
        id: Number(r["id"]), ...(r["signer_id"] ? { signerId: String(r["signer_id"]) } : {}), actorName: String(r["display_name"]), eventType: r["event_type"] as EventType,
        ...(r["ip"] ? { ip: String(r["ip"]) } : {}), detail: (r["detail"] ?? {}) as Record<string, unknown>, occurredAt: iso(r["occurred_at"])
      } satisfies SigningEvent));
    },
    async appendEvent(e) {
      await db.query(
        `INSERT INTO signing_event (document_id, signer_id, actor_user_id, event_type, body_sha256, ip, user_agent, detail, occurred_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)`,
        [e.documentId, e.signerId ?? null, e.actorUserId, e.eventType, e.bodySha256, e.ip ?? null, e.userAgent?.slice(0, 300) ?? null, JSON.stringify(e.detail ?? {}), e.at]
      );
    },
    async setStatus(id, from, to, at) {
      const res = await db.query(
        `UPDATE signing_document SET status = $3::text, sent_at = CASE WHEN $3::text = 'out_for_signature' THEN $4::timestamptz ELSE sent_at END,
           closed_at = CASE WHEN $3::text IN ('completed','declined','cancelled') THEN $4::timestamptz ELSE closed_at END
         WHERE id = $1::uuid AND status = ANY($2::text[]) RETURNING id`, [id, [...from], to, at]);
      return res.rows.length > 0;
    },
    async decide(signerId, decision, typedName, at) {
      const res = await db.query(
        "UPDATE signing_signer SET status = $2::text, typed_name = $3::text, signed_at = CASE WHEN $2::text = 'signed' THEN $4::timestamptz ELSE NULL END WHERE id = $1::uuid AND status = 'pending' RETURNING id",
        [signerId, decision, typedName, at]);
      return res.rows.length > 0;
    },
    async signerContacts(documentId) {
      const res = await db.query(
        "SELECT s.id, s.user_id, u.display_name, u.email, s.role_label, s.esign_recipient_id FROM signing_signer s JOIN app_user u ON u.id = s.user_id WHERE s.document_id = $1::uuid ORDER BY s.id", [documentId]);
      return res.rows.map(r => ({ signerId: String(r["id"]), userId: String(r["user_id"]), name: String(r["display_name"]), email: String(r["email"]), roleLabel: String(r["role_label"]),
        ...(r["esign_recipient_id"] ? { recipientId: String(r["esign_recipient_id"]) } : {}) }));
    },
    async setEnvelope(documentId, envelopeId, recipients) {
      const res = await db.query("UPDATE signing_document SET esign_envelope_id = $2 WHERE id = $1::uuid AND esign_envelope_id IS NULL RETURNING id", [documentId, envelopeId]);
      if (res.rows.length === 0) return false;
      for (const r of recipients) await db.query("UPDATE signing_signer SET esign_recipient_id = $2 WHERE id = $1::uuid AND document_id = $3::uuid", [r.signerId, r.recipientId, documentId]);
      return true;
    },
    async documentByEnvelope(envelopeId) {
      const id = (await db.query("SELECT id FROM signing_document WHERE esign_envelope_id = $1", [envelopeId])).rows[0]?.["id"];
      return id ? repo.document(String(id)) : undefined;
    },
    async addArtifacts(documentId, items, at) {
      for (const i of items) {
        let propertyDocId: string | null = null;
        if (i.kind === "signed_pdf") {
          // Also lands in the listing's document history, owned by the listing's owner, visible to the parties to the document.
          const pd = await db.query(
            `INSERT INTO property_document (property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status)
             SELECT l.property_id, l.id, 'contract', $2, $3, l.owner_user_id, 'platform', 'application/pdf', $4, 'parties', 'active'
               FROM signing_document d JOIN property_listing l ON l.id = d.listing_id WHERE d.id = $1::uuid AND l.property_id IS NOT NULL RETURNING id`,
            [documentId, i.storageKey, i.sha256, i.sizeBytes]);
          propertyDocId = pd.rows[0] ? String(pd.rows[0]["id"]) : null;
        }
        await db.query(
          `INSERT INTO signing_artifact (document_id, kind, storage_key, sha256, size_bytes, property_document_id, created_at)
           VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7::timestamptz) ON CONFLICT (document_id, kind) DO NOTHING`,
          [documentId, i.kind, i.storageKey, i.sha256, i.sizeBytes, propertyDocId, at]);
      }
    },
    async artifacts(documentId) {
      const res = await db.query("SELECT id, kind, sha256, size_bytes, created_at FROM signing_artifact WHERE document_id = $1::uuid ORDER BY created_at, kind", [documentId]);
      return res.rows.map(r => ({ id: String(r["id"]), kind: r["kind"] as ArtifactRow["kind"], sha256: String(r["sha256"]), sizeBytes: Number(r["size_bytes"]), createdAt: iso(r["created_at"]) }));
    },
    async artifactKey(documentId, kind) {
      const r = (await db.query("SELECT storage_key FROM signing_artifact WHERE document_id = $1::uuid AND kind = $2", [documentId, kind])).rows[0];
      return r ? String(r["storage_key"]) : undefined;
    },
    async atomic(documentId, fn) {
      if (!db.transaction) return fn(repo);
      return db.transaction(async tx => {
        if (documentId) await tx.query("SELECT id FROM signing_document WHERE id = $1::uuid FOR UPDATE", [documentId]);
        return fn(createPgSigningRepository(tx));
      });
    }
  };
  return repo;
}

/** Wired from the shared pool in context.ts, so that file stays untouched. */
export const getSigningRepo = () => createPgSigningRepository(getDb());
export const signingIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };

/** Address and browser of the request, stored with each signing step. The address is taken from trusted proxy hops only. */
export const requestContext = (req: Request) => ({ ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 300) || undefined });

/** The assistant who guides the signing: the live persona (Elena by default). Never throws; falls back to the default. */
export async function signingPersona(): Promise<ChatPersona> {
  let id: unknown;
  try { id = await getLivePersona(); } catch { id = undefined; }
  const p = personaById(id);
  return { id: p.id, name: p.name, icon: p.icon, portrait: p.portrait, poses: p.poses };
}
