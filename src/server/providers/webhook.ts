import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderId } from "./errors";

/**
 * Generic signed-webhook scheme used until a provider's real format is known (each provider PR may replace `verify`):
 *   x-webhook-timestamp: unix seconds        x-webhook-signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * The timestamp is inside the signature and must be within 5 minutes, so a captured delivery cannot be replayed later.
 */
export const TIMESTAMP_HEADER = "x-webhook-timestamp";
export const SIGNATURE_HEADER = "x-webhook-signature";
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const TOLERANCE_SECONDS = 300;

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function signatureValid(secret: string, rawBody: string, timestamp: string | null, signatureHex: string | null, nowSeconds: number): boolean {
  if (!timestamp || !/^\d{9,12}$/.test(timestamp) || !signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  return timingSafeEqual(Buffer.from(sign(secret, timestamp, rawBody), "hex"), Buffer.from(signatureHex, "hex"));
}

export interface ProviderEventInput { provider: ProviderId; eventId: string; eventType: string; payload: unknown; bodySha256: string }
export interface ProviderEventStore {
  /** inserted=false means this provider/eventId was already stored (a repeat delivery). */
  record(e: ProviderEventInput): Promise<{ inserted: boolean; id?: string }>;
  finish(id: string, status: "processed" | "ignored" | "failed", error?: string): Promise<void>;
}
/** Later provider PRs plug their processing in here. Throwing marks the event failed (the delivery is still acknowledged). */
export type ProviderEventHandler = (e: ProviderEventInput) => Promise<"processed" | "ignored">;

export interface WebhookReply { status: number; body: Record<string, unknown> }

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export async function handleProviderWebhook(args: {
  provider: ProviderId; secret: string | undefined; rawBody: string; headers: Headers; store: ProviderEventStore;
  nowSeconds: number; onEvent?: ProviderEventHandler;
}): Promise<WebhookReply> {
  const { provider, secret, rawBody, headers, store } = args;
  if (!secret || secret.length < 32) return { status: 503, body: { error: "This webhook is not enabled." } };
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!signatureValid(secret, rawBody, headers.get(TIMESTAMP_HEADER), headers.get(SIGNATURE_HEADER), args.nowSeconds)) return { status: 401, body: { error: "Invalid signature." } };
  let obj: unknown;
  try { obj = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "Invalid event." } }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { status: 400, body: { error: "Invalid event." } };
  const o = obj as Record<string, unknown>;
  const eventType = str(o["type"], 100) ?? str(o["eventType"], 100);
  if (!eventType) return { status: 400, body: { error: "Invalid event." } };
  const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const event: ProviderEventInput = { provider, eventId: str(o["eventId"], 200) ?? str(o["id"], 200) ?? bodySha256, eventType, payload: obj, bodySha256 };
  const stored = await store.record(event);
  if (!stored.inserted || !stored.id) return { status: 200, body: { ok: true, note: "Duplicate event ignored." } };
  if (args.onEvent) {
    try { await store.finish(stored.id, await args.onEvent(event)); }
    catch { await store.finish(stored.id, "failed", "Handler failed."); }
  }
  return { status: 200, body: { ok: true } };
}
