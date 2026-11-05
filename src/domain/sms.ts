import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * SMS text rules, delivery status vocabulary, Twilio webhook signature and cost estimate. Pure.
 * Transactional only: nothing here is for marketing texts.
 */

// ---- Length and segments -------------------------------------------------------------------------------------------------------
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** Curly quotes, dashes and the ellipsis are common in our wording and would force the costlier UCS-2 encoding. */
export function toGsmFriendly(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/ /g, " ");
}

export const isGsm7 = (text: string): boolean => [...text].every(c => GSM_BASIC.includes(c) || GSM_EXT.includes(c));

/** Characters the text takes on the wire (GSM extension characters count twice; UCS-2 counts UTF-16 units). */
export function smsLength(text: string): number {
  if (!isGsm7(text)) return text.length;
  let n = 0;
  for (const c of text) n += GSM_EXT.includes(c) ? 2 : 1;
  return n;
}

/** Number of billable segments: GSM-7 160 / 153, UCS-2 70 / 67. */
export function smsSegments(text: string): number {
  const len = smsLength(text);
  if (len === 0) return 0;
  const [single, multi] = isGsm7(text) ? [160, 153] : [70, 67];
  return len <= single ? 1 : Math.ceil(len / multi);
}

export const SMS_MAX_SEGMENTS = 2;
export const SMS_OPT_OUT_HINT = "Turn texts off: Settings > Notifications.";

/**
 * "Brand: message. Turn texts off: Settings > Notifications." kept within `maxSegments`. The message is shortened (with "...") before the
 * hint is, so the opt-out wording is always present.
 */
export function formatNotificationSms(brand: string, message: string, maxSegments: number = SMS_MAX_SEGMENTS): { text: string; segments: number } {
  const head = toGsmFriendly(`${brand}: `);
  const tail = ` ${SMS_OPT_OUT_HINT}`;
  let body = toGsmFriendly(message).replace(/\s+/g, " ").trim();
  const fits = (b: string) => smsSegments(head + b + tail) <= maxSegments;
  if (!fits(body)) {
    // Binary search for the longest prefix that fits, so a pathological message cannot loop.
    let lo = 0, hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(body.slice(0, mid).trimEnd() + "...")) lo = mid; else hi = mid - 1;
    }
    body = body.slice(0, lo).trimEnd() + "...";
  }
  const text = head + body + tail;
  return { text, segments: smsSegments(text) };
}

// ---- Delivery status -----------------------------------------------------------------------------------------------------------
export const SMS_STATUSES = ["queued", "sent", "delivered", "undelivered", "failed"] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

/** Twilio message statuses to ours. Unknown values map to undefined and are ignored. */
export function mapProviderStatus(raw: unknown): SmsStatus | undefined {
  switch (typeof raw === "string" ? raw.toLowerCase() : "") {
    case "accepted": case "scheduled": case "queued": case "sending": return "queued";
    case "sent": return "sent";
    case "delivered": case "read": return "delivered";
    case "undelivered": return "undelivered";
    case "failed": case "canceled": return "failed";
    default: return undefined;
  }
}

const RANK: Record<SmsStatus, number> = { queued: 0, sent: 1, delivered: 2, undelivered: 2, failed: 2 };
/** Callbacks can arrive out of order: a status only replaces an earlier one, and a final status is never replaced. */
export const statusAdvances = (from: SmsStatus, to: SmsStatus): boolean => RANK[to] > RANK[from];

/** Provider error numbers (e.g. 30003) as a stored code, or null. */
export const errorCodeOf = (raw: unknown): string | null => (typeof raw === "string" && /^\d{3,6}$/.test(raw) ? `e${raw}` : null);

// ---- Webhook signature ---------------------------------------------------------------------------------------------------------
/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 over the full URL plus every POST field (sorted by name) as name+value. */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const names = [...new Set([...params.keys()])].sort();
  const data = names.reduce((acc, k) => acc + k + (params.getAll(k)[0] ?? ""), url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function twilioSignatureValid(authToken: string, url: string, params: URLSearchParams, header: string | null): boolean {
  if (!header || header.length > 64 || authToken.length === 0) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Texts a person sends to stop messages. Matched on the whole trimmed message, case-insensitive (the carrier rules). */
export const isStopKeyword = (body: unknown): boolean =>
  typeof body === "string" && ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(body.trim().toLowerCase());

// ---- Cost and limits -----------------------------------------------------------------------------------------------------------
/** Placeholder price per segment in cents until the real rate for the sender is known. Set SMS_COST_PER_SEGMENT_CENTS. */
export const DEFAULT_SEGMENT_CENTS = 8;
const MICROS_PER_CENT = 10_000;

/** Per-segment price in millionths of a dollar. A bad, negative or missing value falls back to the default. */
export function segmentMicros(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["SMS_COST_PER_SEGMENT_CENTS"];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const cents = Number.isFinite(n) && n >= 0 && n <= 1000 ? n : DEFAULT_SEGMENT_CENTS;
  return Math.round(cents * MICROS_PER_CENT);
}
export const estimateMicros = (segments: number, perSegmentMicros: number): number => segments * perSegmentMicros;

/** Provider price string ("-0.0750") to positive millionths of a dollar, or null. */
export function priceToMicros(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^-?\d{1,6}(\.\d{1,6})?$/.test(raw)) return null;
  return Math.round(Math.abs(Number(raw)) * 1_000_000);
}
export const formatMoney = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

/** Transactional texts per user, so a burst of events (or a bug) cannot flood a phone. Over the limit the text is skipped; in-app and email still go. */
export const SMS_NOTIFY_RATE = { perHour: 5, perDay: 15 } as const;
