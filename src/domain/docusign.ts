import { createHmac, timingSafeEqual } from "node:crypto";
import type { RenderedClause } from "./doc-templates";

/**
 * Pure DocuSign helpers: the envelope we send, the HTML document DocuSign signs, and reading and authenticating Connect webhooks.
 * No network and no secrets here (src/adapters/docusign.ts does the calls). Roles are free text so a document can name any party;
 * the owner screen offers the suggestions in app/signing/labels.ts.
 */

export interface EnvelopeSigner { recipientId: string; clientUserId: string; name: string; email: string; roleLabel: string; routingOrder: number }
export interface EnvelopeInput { subject: string; title: string; html: string; signers: EnvelopeSigner[]; webhookUrl?: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Anchor text for one signer's signature box. Rendered in white so DocuSign can find it without the reader seeing it. */
export const signAnchor = (recipientId: string) => `/ol_sign_${recipientId}/`;
export const dateAnchor = (recipientId: string) => `/ol_date_${recipientId}/`;

/** The exact frozen text as a simple HTML page, with the fingerprint and one signature block per signer. */
export function renderDocumentHtml(input: { title: string; listingTitle: string; bodySha256: string; clauses: RenderedClause[]; signers: Pick<EnvelopeSigner, "recipientId" | "name" | "roleLabel">[] }): string {
  const clauses = input.clauses.map((c, i) => `<h3>${i + 1}. ${esc(c.heading)}</h3><p style="white-space:pre-wrap">${esc(c.text)}</p>`).join("");
  const blocks = input.signers.map(s =>
    `<div style="margin-top:28px;page-break-inside:avoid"><p><strong>${esc(s.roleLabel)}</strong>: ${esc(s.name)}</p>` +
    `<p style="color:#fff;font-size:8px">${signAnchor(s.recipientId)}</p><p>Signature above. Date: <span style="color:#fff;font-size:8px">${dateAnchor(s.recipientId)}</span></p></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(input.title)}</title></head>` +
    `<body style="font-family:Arial,sans-serif;font-size:12px;line-height:1.5"><h1>${esc(input.title)}</h1><p>${esc(input.listingTitle)}</p>${clauses}` +
    `<p style="margin-top:24px;font-size:9px">Fingerprint of this text (SHA-256): ${esc(input.bodySha256)}</p>${blocks}</body></html>`;
}

/** Body for POST /envelopes. Embedded signing (clientUserId): signers sign inside DocuSign after we send them there from their own account. */
export function buildEnvelope(input: EnvelopeInput): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    emailSubject: input.subject.slice(0, 100),
    status: "sent",
    documents: [{ documentId: "1", name: input.title.slice(0, 100), htmlDefinition: { source: input.html } }],
    recipients: {
      signers: input.signers.map(s => ({
        recipientId: s.recipientId, clientUserId: s.clientUserId, name: s.name, email: s.email, roleName: s.roleLabel.slice(0, 60), routingOrder: String(s.routingOrder),
        tabs: {
          signHereTabs: [{ anchorString: signAnchor(s.recipientId), anchorUnits: "pixels", anchorYOffset: "-6", anchorXOffset: "0" }],
          dateSignedTabs: [{ anchorString: dateAnchor(s.recipientId), anchorUnits: "pixels" }]
        }
      }))
    }
  };
  if (input.webhookUrl) {
    envelope["eventNotification"] = {
      url: input.webhookUrl, loggingEnabled: "true", requireAcknowledgment: "true", includeHMAC: "true", eventData: { version: "restv2.1" },
      envelopeEvents: ["delivered", "completed", "declined", "voided"].map(s => ({ envelopeEventStatusCode: s })),
      recipientEvents: ["Delivered", "Completed", "Declined"].map(s => ({ recipientEventStatusCode: s }))
    };
  }
  return envelope;
}

/** DocuSign signs the raw body with HMAC-SHA256 (base64) in X-DocuSign-Signature-1 (and -2 ... while keys rotate). Any one match passes. */
export function verifyConnectSignature(secret: string, rawBody: string, headers: readonly (string | null | undefined)[]): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return headers.some(h => {
    if (!h) return false;
    const got = Buffer.from(h.trim(), "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export type RecipientState = "delivered" | "completed" | "declined";
export type EnvelopeState = "sent" | "delivered" | "completed" | "declined" | "voided";
export interface RecipientUpdate { recipientId: string; state: RecipientState; declinedReason?: string }
/** What a Connect event or a status poll says, in our terms. */
export interface EnvelopeUpdate { envelopeId: string; envelope?: EnvelopeState; recipients: RecipientUpdate[] }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const ENVELOPE_STATES: readonly string[] = ["sent", "delivered", "completed", "declined", "voided"];
const RECIPIENT_STATES: readonly string[] = ["delivered", "completed", "declined"];

/** Recipients in a DocuSign envelope or summary object. Unknown statuses (created, sent, signed in transit) are ignored. */
export function recipientsFrom(v: unknown): RecipientUpdate[] {
  const signers = isObj(v) && isObj(v["recipients"]) && Array.isArray(v["recipients"]["signers"]) ? v["recipients"]["signers"] : isObj(v) && Array.isArray(v["signers"]) ? v["signers"] : [];
  const out: RecipientUpdate[] = [];
  for (const s of signers) {
    if (!isObj(s)) continue;
    const recipientId = str(s["recipientId"]);
    const state = str(s["status"])?.toLowerCase();
    if (!recipientId || !state || !RECIPIENT_STATES.includes(state)) continue;
    const reason = str(s["declinedReason"])?.trim().slice(0, 500);
    out.push({ recipientId, state: state as RecipientState, ...(reason ? { declinedReason: reason } : {}) });
  }
  return out;
}

/** Reads a Connect JSON event (restv2.1: { event, data: { envelopeId, envelopeSummary } }). Returns null for anything we do not act on. */
export function parseConnectEvent(payload: unknown): EnvelopeUpdate | null {
  if (!isObj(payload) || !isObj(payload["data"])) return null;
  const data = payload["data"];
  const envelopeId = str(data["envelopeId"]);
  if (!envelopeId) return null;
  const summary = isObj(data["envelopeSummary"]) ? data["envelopeSummary"] : {};
  const status = str(summary["status"])?.toLowerCase();
  const event = str(payload["event"])?.toLowerCase() ?? "";
  const recipients = recipientsFrom(summary);
  const envelope = event.startsWith("envelope-") && status && ENVELOPE_STATES.includes(status) ? (status as EnvelopeState) : undefined;
  if (!envelope && recipients.length === 0) return null;
  return { envelopeId, ...(envelope ? { envelope } : {}), recipients };
}
