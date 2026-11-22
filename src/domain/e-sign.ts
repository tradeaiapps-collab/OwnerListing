import { createHash, createHmac } from "node:crypto";

/** Control characters, angle brackets and braces never belong in these short notes. */
const PLAIN = /^[^\u0000-\u0008\u000b-\u001f\u007f<>{}`]*$/;

export const plainText = (v: unknown, max: number, required: boolean): string | null | undefined => {
  if (v === undefined || v === null || v === "") return required ? undefined : null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return required ? undefined : null;
  return t.length <= max && PLAIN.test(t) ? t : undefined;
};


/**
 * Built-in electronic signing. A signer who is signed in reads the document, ticks the consent and types their full name.
 * We keep, for each signature: the document's SHA-256 (the document cannot change under a request), the typed name, the consent
 * wording version, the time, a keyed hash of the network address and an evidence hash over all of those.
 * Electronic signing is not allowed to stand in for formalities a state requires of a particular document (for example a land
 * contract): the templates say so, and counsel sign-off is tracked in docs/COUNSEL_QUESTIONS.md. A DocuSign-style provider can
 * replace this later because the request and signer tables only record the outcome.
 */
export const LIMITS = { reason: 300 } as const;
export const ESIGN_CONSENT_VERSION = "2026-11-v1";
export const ESIGN_CONSENT_TEXT =
  "I agree to sign this document electronically. I understand that typing my full name below is my signature, that I have read the whole document, " +
  "and that I can ask the sender for a paper copy. I can withdraw by declining before I sign.";
export const SIGN_EXPIRY_DAYS = 14;
export const MAX_SIGNERS = 4;

export type SignerStatus = "pending" | "signed" | "declined";
export type RequestStatus = "pending" | "completed" | "declined" | "cancelled" | "expired";

export interface EvidenceInput { contentSha256: string; requestId: string; userId: string; typedName: string; signedAtIso: string; consentVersion: string }

export function evidenceHash(e: EvidenceInput): string {
  // Fixed key order, so the same facts always give the same hash.
  const canonical = JSON.stringify([e.contentSha256, e.requestId, e.userId, e.typedName, e.signedAtIso, e.consentVersion]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Keyed hash so the raw address is never stored. Falls back to a fixed label when no key is set. */
export function ipHash(ip: string, secret: string | undefined): string {
  return createHmac("sha256", `${secret ?? "unkeyed"}:esign-ip:v1`).update(ip).digest("hex");
}

export function parseSignature(body: unknown): { ok: true; typedName: string } | { ok: false; message: string } {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b["consent"] !== true) return { ok: false, message: "Tick the box to agree to sign electronically." };
  if (b["consentVersion"] !== ESIGN_CONSENT_VERSION) return { ok: false, message: "The consent wording has changed. Reload the page and read it again." };
  const name = plainText(b["typedName"], 120, true);
  if (!name || name.length < 2 || !/\s/.test(name) || !/\p{L}/u.test(name)) return { ok: false, message: "Type your full name (first and last)." };
  return { ok: true, typedName: name };
}

export function parseSigners(body: unknown): { ok: true; signers: { userId: string; roleLabel: string }[] } | { ok: false; message: string } {
  if (!Array.isArray(body) || body.length < 1 || body.length > MAX_SIGNERS) return { ok: false, message: `Choose 1 to ${MAX_SIGNERS} signers.` };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen = new Set<string>();
  const out: { userId: string; roleLabel: string }[] = [];
  for (const raw of body) {
    const s = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const role = plainText(s["roleLabel"], 40, true);
    if (typeof s["userId"] !== "string" || !uuid.test(s["userId"]) || !role) return { ok: false, message: "Each signer needs a person and a role." };
    if (seen.has(s["userId"].toLowerCase())) return { ok: false, message: "Each person can be added once." };
    seen.add(s["userId"].toLowerCase());
    out.push({ userId: s["userId"], roleLabel: role });
  }
  return { ok: true, signers: out };
}

/** The request status once these signers have answered. One decline closes the request; it completes when everyone has signed. */
export function requestStatusAfter(signers: readonly SignerStatus[]): "pending" | "completed" | "declined" {
  if (signers.includes("declined")) return "declined";
  return signers.length > 0 && signers.every(s => s === "signed") ? "completed" : "pending";
}

export const expiryFrom = (nowIso: string): string => new Date(Date.parse(nowIso) + SIGN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
