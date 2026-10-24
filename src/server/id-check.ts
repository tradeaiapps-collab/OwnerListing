import { randomUUID } from "node:crypto";
import type { IdCheckPort } from "../adapters/id-check";
import { ID_START_RATE, secretUsable, sha256Hex } from "../domain/phone-verification";
import { withinLimit } from "../domain/rate-limit";
import type { Failure, Result } from "../domain/listing-service";
import { signatureValid } from "./payment-webhook";

export const ID_SIGNATURE_HEADER = "x-idcheck-signature";
const MAX_BODY_BYTES = 16 * 1024;

export type IdLogEvent = "start_requested" | "start_failed";
export type IdResult = "applied" | "duplicate" | "unknown";

export interface IdStore {
  /** Counts one hit in a fixed window and returns the new count. Bucket is already hashed. */
  hit(bucket: string, windowMs: number): Promise<number | undefined>;
  state(userId: string): Promise<{ phoneVerified: boolean; idVerified: boolean }>;
  recordSession(userId: string, providerRef: string): Promise<void>;
  log(userId: string, event: IdLogEvent, providerRef: string | null): Promise<void>;
  /**
   * Applies a provider result once (keyed by eventId). Only a session still "started" can change; "passed" also sets
   * id_verified_at. Known sessions are logged once per eventId; an unknown reference changes and logs nothing. "duplicate" for a repeated eventId, "unknown" for a reference we never issued.
   */
  applyResult(eventId: string, providerRef: string, outcome: "passed" | "failed"): Promise<IdResult>;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const short = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** Starts a provider ID-check session for a buyer whose mobile is verified. Refused while the port is unconfigured. */
export async function startIdCheck(d: { store: IdStore; port: IdCheckPort }, userId: string): Promise<Result<{ redirectUrl: string }>> {
  if (!d.port.configured) return fail("unavailable", "ID check is not available yet.");
  const s = await d.store.state(userId);
  if (!s.phoneVerified) return fail("forbidden", "Verify your mobile number first.");
  if (s.idVerified) return fail("conflict", "Your ID is already verified.");
  if (!withinLimit(await d.store.hit(sha256Hex(`id-start:user:${userId}`), ID_START_RATE.windowMs), ID_START_RATE.perUser)) {
    return fail("rate_limited", "Too many attempts today. Try again tomorrow.");
  }
  await d.store.log(userId, "start_requested", null);
  let started: { providerRef: string; redirectUrl: string };
  try {
    started = await d.port.startSession(randomUUID());
  } catch {
    await d.store.log(userId, "start_failed", null);
    return fail("unavailable", "We could not start the ID check. Try again later.");
  }
  if (!short(started?.providerRef) || typeof started.redirectUrl !== "string" || !/^https:\/\//i.test(started.redirectUrl)) {
    await d.store.log(userId, "start_failed", null);
    return fail("unavailable", "We could not start the ID check. Try again later.");
  }
  await d.store.recordSession(userId, started.providerRef);
  return { ok: true, value: { redirectUrl: started.redirectUrl } };
}

export interface WebhookReply { status: number; body: Record<string, unknown> }

/** Provider result webhook. Rejects everything while the secret is unset or the HMAC is wrong; a result is applied once. */
export async function handleIdCheckWebhook(store: IdStore, rawBody: string, signature: string | null, secret: string | undefined): Promise<WebhookReply> {
  if (!secretUsable(secret)) return { status: 503, body: { error: "ID check webhooks are not enabled." } };
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!signatureValid(rawBody, signature, secret)) return { status: 401, body: { error: "Invalid signature." } };
  let o: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(rawBody);
    if (!p || typeof p !== "object") return { status: 400, body: { error: "Invalid event." } };
    o = p as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "Invalid event." } };
  }
  const outcome = o["outcome"];
  if (!short(o["eventId"]) || !short(o["providerRef"]) || (outcome !== "passed" && outcome !== "failed")) return { status: 400, body: { error: "Invalid event." } };
  const r = await store.applyResult(o["eventId"], o["providerRef"], outcome);
  if (r === "unknown") return { status: 404, body: { error: "Unknown session." } };
  return { status: 200, body: { ok: true, ...(r === "duplicate" ? { note: "Duplicate event ignored." } : {}) } };
}
