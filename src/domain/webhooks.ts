import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./webhook-events";
import { hostProblem } from "./net-guard";

/** Webhook rules: event names, URL checks, signing and the retry schedule. Pure. */
export { WEBHOOK_EVENTS, type WebhookEvent };
export const MAX_ENDPOINTS_PER_USER = 5;
/** Waits before attempt 2, 3, 4, 5. After the fifth failed attempt the delivery is marked failed. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
export const DISABLE_AFTER_FAILURES = 10;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString("base64url")}`;

export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.length > 500) return { ok: false, message: "Enter a webhook URL of at most 500 characters." };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, message: "That is not a valid URL." }; }
  if (u.protocol !== "https:") return { ok: false, message: "Webhook URLs must start with https://." };
  if (u.username || u.password) return { ok: false, message: "Do not put credentials in the URL." };
  if (u.port && u.port !== "443") return { ok: false, message: "Webhook URLs must use the standard https port." };
  const problem = hostProblem(u.hostname);
  if (problem) return { ok: false, message: problem };
  u.hash = "";
  return { ok: true, url: u.toString() };
}

export function parseEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const e of input) {
    if (typeof e !== "string" || !(WEBHOOK_EVENTS as readonly string[]).includes(e)) return null;
    if (!out.includes(e as WebhookEvent)) out.push(e as WebhookEvent);
  }
  return out;
}

/** Header value `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. Receivers recompute it and reject old timestamps. */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifySignature(secret: string, body: string, header: string, nowSeconds: number): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const want = Buffer.from(signPayload(secret, body, t));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function nextAttemptDelaySeconds(attemptsMade: number): number | null {
  return attemptsMade >= 1 && attemptsMade <= RETRY_DELAYS_SECONDS.length ? RETRY_DELAYS_SECONDS[attemptsMade - 1]! : null;
}

export interface WebhookEnvelope { id: string; type: string; createdAt: string; data: Record<string, unknown> }
export const envelopeBody = (e: WebhookEnvelope): string => JSON.stringify(e);
