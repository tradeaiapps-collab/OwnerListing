import { createHmac, timingSafeEqual } from "node:crypto";
import type { KycStatus, PayoutProvider, ProviderEvent, TeamPayoutRepository } from "../domain/team-payout";
import { applyProviderEvent } from "../domain/team-payout";
import type { TeamIds } from "../domain/agency-team";

// Stripe Connect (Express accounts) adapter, plain fetch so tests can inject it. Stripe hosts identity checks and bank details,
// so no card or bank numbers touch this server. Off unless PAYOUTS_ENABLED=1 and a key is set. A live key (sk_live_) is refused
// unless PAYOUTS_ALLOW_LIVE=1: project rule, no live payment keys until the pen test and counsel sign-off.

type Env = Record<string, string | undefined>;
const API = "https://api.stripe.com/v1";
const TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 256 * 1024;

export function payoutsEnabled(env: Env): boolean {
  const key = env["STRIPE_SECRET_KEY"] ?? "";
  if (env["PAYOUTS_ENABLED"] !== "1" || !/^sk_(test|live)_[A-Za-z0-9]{8,}$/.test(key)) return false;
  return key.startsWith("sk_test_") || env["PAYOUTS_ALLOW_LIVE"] === "1";
}

export function createStripePayoutProvider(env: Env = process.env, fetchImpl: typeof fetch = fetch): PayoutProvider {
  async function call(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${env["STRIPE_SECRET_KEY"]}`, "content-type": "application/x-www-form-urlencoded" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetchImpl(`${API}${path}`, { method: "POST", headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = body["error"] as Record<string, unknown> | undefined;
      throw new Error(`Stripe ${res.status}: ${typeof err?.["message"] === "string" ? err["message"] : "request failed"}`);
    }
    return body;
  }
  const str = (v: unknown): string => { if (typeof v !== "string" || !v) throw new Error("Stripe reply missing id."); return v; };
  return {
    enabled: () => payoutsEnabled(env),
    async createAccount({ userId, email }) {
      const a = await call("/accounts", {
        type: "express", country: "AU", email, business_type: "individual",
        "capabilities[transfers][requested]": "true", "metadata[userId]": userId
      }, `account-${userId}`);
      return { accountId: str(a["id"]) };
    },
    async onboardingLink(accountId, urls) {
      const l = await call("/account_links", { account: accountId, type: "account_onboarding", return_url: urls.returnUrl, refresh_url: urls.refreshUrl });
      return { url: str(l["url"]) };
    },
    async transfer({ accountId, amountCents, idempotencyKey, metadata }) {
      const form: Record<string, string> = { amount: String(amountCents), currency: "aud", destination: accountId };
      for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
      return { transferId: str((await call("/transfers", form, idempotencyKey))["id"]) };
    }
  };
}

/** Stripe-Signature is "t=<unix>,v1=<hex>[,v1=...]"; v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Constant-time, with a replay window. */
export function stripeSignatureValid(rawBody: string, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "t") t = v; else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || sigs.length === 0 || Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some(s => timingSafeEqual(expected, Buffer.from(s, "hex")));
}

/** Maps the Stripe events we care about; everything else returns undefined and is acknowledged. */
export function parseStripeEvent(rawBody: string): ProviderEvent | undefined | null {
  let b: unknown;
  try { b = JSON.parse(rawBody); } catch { return null; }
  const o = b as { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } } | null;
  if (!o || typeof o.id !== "string" || typeof o.type !== "string") return null;
  const obj = o.data?.object;
  if (!obj || typeof obj["id"] !== "string") return undefined;
  if (o.type === "account.updated") {
    const reqs = obj["requirements"] as { disabled_reason?: unknown } | undefined;
    const kyc: KycStatus = obj["payouts_enabled"] === true && obj["details_submitted"] === true ? "verified" : reqs?.disabled_reason ? "restricted" : "pending";
    return { id: o.id, kind: "account", providerAccountId: obj["id"], kycStatus: kyc };
  }
  if (o.type === "transfer.created") return { id: o.id, kind: "transfer", transferId: obj["id"], outcome: "paid", reason: "" };
  if (o.type === "transfer.reversed") return { id: o.id, kind: "transfer", transferId: obj["id"], outcome: "failed", reason: "Transfer reversed by the provider." };
  return undefined;
}

export interface WebhookReply { status: number; body: Record<string, unknown> }

/** Fails closed while the secret is unset. Verified events are applied once; repeats are acknowledged. */
export async function handleStripeWebhook(
  repo: TeamPayoutRepository, rawBody: string, signature: string | null, secret: string | undefined, ids: TeamIds,
  notify?: Parameters<typeof applyProviderEvent>[3]
): Promise<WebhookReply> {
  if (!secret) return { status: 503, body: { error: "Payout webhooks are not enabled." } };
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!stripeSignatureValid(rawBody, signature, secret)) return { status: 401, body: { error: "Invalid signature." } };
  const e = parseStripeEvent(rawBody);
  if (e === null) return { status: 400, body: { error: "Invalid event." } };
  if (e === undefined) return { status: 200, body: { ok: true, note: "Event type ignored." } };
  return { status: 200, body: { ok: true, result: await applyProviderEvent(repo, e, ids, notify) } };
}
