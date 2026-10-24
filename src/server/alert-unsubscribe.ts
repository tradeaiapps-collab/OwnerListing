import { createHmac, timingSafeEqual } from "node:crypto";
import type { AlertChannel } from "../domain/alerts";

/**
 * Signed unsubscribe tokens for alert messages: "v1.<base64url buyer:channel>.<base64url HMAC-SHA256>".
 * Fails closed: without a key of at least 32 characters no token is made and none verifies, so no alert is sent.
 * The token carries no expiry on purpose (an unsubscribe link must keep working) and grants one power: turn one channel off.
 */
const MIN_KEY = 32;
const usable = (key: string | undefined): key is string => typeof key === "string" && key.length >= MIN_KEY;
const sign = (key: string, body: string) => createHmac("sha256", key).update(`alert-unsubscribe.v1.${body}`).digest("base64url");

export function makeUnsubscribeToken(buyerUserId: string, channel: AlertChannel, key: string | undefined): string | undefined {
  if (!usable(key)) return undefined;
  const body = Buffer.from(`${buyerUserId}:${channel}`, "utf8").toString("base64url");
  return `v1.${body}.${sign(key, body)}`;
}

export function readUnsubscribeToken(token: unknown, key: string | undefined): { buyerUserId: string; channel: AlertChannel } | undefined {
  if (!usable(key) || typeof token !== "string" || token.length > 300) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return undefined;
  const [, body, sig] = parts as [string, string, string];
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  const [buyerUserId, channel, extra] = Buffer.from(body, "base64url").toString("utf8").split(":");
  if (!buyerUserId || extra !== undefined || (channel !== "email" && channel !== "sms")) return undefined;
  return { buyerUserId, channel };
}

/** The link put in each alert. Empty (so dispatch refuses to send) unless both APP_URL and the signing key are set. */
export function unsubscribeUrlFor(env: Readonly<Record<string, string | undefined>>, buyerUserId: string, channel: AlertChannel): string {
  const base = env["APP_URL"]?.replace(/\/+$/, "");
  const token = makeUnsubscribeToken(buyerUserId, channel, env["ALERT_UNSUBSCRIBE_KEY"]);
  return base && token ? `${base}/api/alerts/unsubscribe?t=${encodeURIComponent(token)}` : "";
}
