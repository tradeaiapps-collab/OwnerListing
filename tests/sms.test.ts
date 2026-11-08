import { beforeEach, describe, expect, it } from "vitest";
import { normaliseMobile } from "../src/domain/phone-verification";
import {
  SMS_OPT_OUT_HINT, estimateMicros, errorCodeOf, formatMoney, formatNotificationSms, isGsm7, isStopKeyword, mapProviderStatus, priceToMicros,
  segmentMicros, smsSegments, statusAdvances, toGsmFriendly, twilioSignature, twilioSignatureValid
} from "../src/domain/sms";
import { handleSmsInboundWebhook, handleSmsStatusWebhook, webhookUrl } from "../src/server/sms-webhook";
import type { Queryable } from "../src/server/db";

describe("segments and formatting", () => {
  it("counts GSM-7 and UCS-2 segments", () => {
    expect(smsSegments("")).toBe(0);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
    expect(smsSegments("{".repeat(81))).toBe(2); // extension characters take two places
    expect(isGsm7("café")).toBe(true);
    expect(isGsm7("hi \u{1F600}")).toBe(false);
    expect(smsSegments("\u{1F600}".repeat(35))).toBe(1); // 70 UTF-16 units
    expect(smsSegments("\u{1F600}".repeat(36))).toBe(2);
  });
  it("turns curly punctuation into GSM characters", () => {
    expect(toGsmFriendly("It’s “new” – now…")).toBe("It's \"new\" - now...");
  });
  it("keeps a short message whole and always ends with the opt-out hint", () => {
    const f = formatNotificationSms("OwnerListing", "New offer on 12 Smith St. Open the app to review.");
    expect(f.text).toBe(`OwnerListing: New offer on 12 Smith St. Open the app to review. ${SMS_OPT_OUT_HINT}`);
    expect(f.segments).toBe(1);
  });
  it("shortens a long message to the segment cap, hint intact", () => {
    const f = formatNotificationSms("OwnerListing", "word ".repeat(200));
    expect(f.segments).toBeLessThanOrEqual(2);
    expect(f.text.endsWith(SMS_OPT_OUT_HINT)).toBe(true);
    expect(f.text).toContain("...");
  });
  it("copes with non-GSM text without exceeding the cap", () => {
    const f = formatNotificationSms("OwnerListing", "你好 ".repeat(100));
    expect(f.segments).toBeLessThanOrEqual(2);
  });
});

describe("delivery status", () => {
  it("maps provider statuses and ignores unknown ones", () => {
    expect(mapProviderStatus("queued")).toBe("queued");
    expect(mapProviderStatus("SENDING")).toBe("queued");
    expect(mapProviderStatus("sent")).toBe("sent");
    expect(mapProviderStatus("delivered")).toBe("delivered");
    expect(mapProviderStatus("undelivered")).toBe("undelivered");
    expect(mapProviderStatus("failed")).toBe("failed");
    expect(mapProviderStatus("bounced?")).toBeUndefined();
    expect(mapProviderStatus(5)).toBeUndefined();
  });
  it("only moves forward and never leaves a final status", () => {
    expect(statusAdvances("queued", "sent")).toBe(true);
    expect(statusAdvances("sent", "delivered")).toBe(true);
    expect(statusAdvances("delivered", "sent")).toBe(false);
    expect(statusAdvances("delivered", "failed")).toBe(false);
    expect(statusAdvances("failed", "delivered")).toBe(false);
    expect(statusAdvances("sent", "sent")).toBe(false);
  });
  it("stores provider error numbers as short codes", () => {
    expect(errorCodeOf("30003")).toBe("e30003");
    expect(errorCodeOf("x; drop")).toBeNull();
    expect(errorCodeOf(undefined)).toBeNull();
  });
});

describe("cost", () => {
  it("uses the configured rate, else the default", () => {
    expect(segmentMicros({})).toBe(80_000);
    expect(segmentMicros({ SMS_COST_PER_SEGMENT_CENTS: "5.5" })).toBe(55_000);
    expect(segmentMicros({ SMS_COST_PER_SEGMENT_CENTS: "-1" })).toBe(80_000);
    expect(segmentMicros({ SMS_COST_PER_SEGMENT_CENTS: "abc" })).toBe(80_000);
    expect(segmentMicros({ SMS_COST_PER_SEGMENT_CENTS: "" })).toBe(80_000);
    expect(estimateMicros(2, 80_000)).toBe(160_000);
    expect(formatMoney(160_000)).toBe("$0.16");
  });
  it("reads provider prices", () => {
    expect(priceToMicros("-0.0750")).toBe(75_000);
    expect(priceToMicros("0.05")).toBe(50_000);
    expect(priceToMicros("free")).toBeNull();
    expect(priceToMicros(undefined)).toBeNull();
  });
});

describe("Twilio signature", () => {
  // Worked example from Twilio's request-validation documentation.
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = new URLSearchParams({ Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" });
  it("matches Twilio's documented value", () => {
    expect(twilioSignature(token, url, params)).toBe("GvWf1cFY/Q7PnoempGyD5oXAezc=");
  });
  it("accepts the right signature and refuses anything else", () => {
    const sig = twilioSignature(token, url, params);
    expect(twilioSignatureValid(token, url, params, sig)).toBe(true);
    expect(twilioSignatureValid(token, url, params, null)).toBe(false);
    expect(twilioSignatureValid(token, url, params, sig.slice(1))).toBe(false);
    expect(twilioSignatureValid("other", url, params, sig)).toBe(false);
    expect(twilioSignatureValid(token, url + "x", params, sig)).toBe(false);
    expect(twilioSignatureValid("", url, params, sig)).toBe(false);
    const tampered = new URLSearchParams(params); tampered.set("Digits", "9999");
    expect(twilioSignatureValid(token, url, tampered, sig)).toBe(false);
  });
});

describe("stop words and phone numbers", () => {
  it("recognises whole-message stop words only", () => {
    for (const w of ["STOP", " stop ", "Unsubscribe", "stopall", "END"]) expect(isStopKeyword(w), w).toBe(true);
    for (const w of ["please stop", "stopping", "", "START", null, 4]) expect(isStopKeyword(w), String(w)).toBe(false);
  });
  it("accepts Australian and US mobiles, in E.164", () => {
    for (const v of ["0400 000 000", "+61 400 000 000"]) expect(normaliseMobile(v), v).toBe("+61400000000");
    for (const v of ["+1 415 555 0132", "1 (415) 555-0132", "+14155550132"]) expect(normaliseMobile(v), v).toBe("+14155550132");
    for (const v of ["4155550132", "+1 115 555 0132", "+1 415 155 0132", "+44 7700 900123", "0212345678", "+141555501320", "", null, 5]) expect(normaliseMobile(v), String(v)).toBeUndefined();
  });
});

describe("webhooks", () => {
  const TOKEN = "webhook-token-1234567890abcdef";
  const env = { APP_URL: "https://owner.example", SMS_WEBHOOK_AUTH_TOKEN: TOKEN };
  const REF = "SM" + "a".repeat(32);
  const calls: string[] = [];
  const db: Queryable = { async query(text: string) { calls.push(text); return { rows: [] }; } };
  const signed = (path: "status" | "inbound", body: string) => twilioSignature(TOKEN, webhookUrl(env, path)!, new URLSearchParams(body));
  beforeEach(() => { calls.length = 0; });
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

  it("needs an https APP_URL and a signing token", async () => {
    expect(webhookUrl({ APP_URL: "http://x.test" }, "status")).toBeUndefined();
    expect(webhookUrl({}, "status")).toBeUndefined();
    expect((await handleSmsStatusWebhook(db, { APP_URL: "http://x.test", SMS_WEBHOOK_AUTH_TOKEN: TOKEN }, "a=1", "sig")).status).toBe(503);
    expect((await handleSmsStatusWebhook(db, { APP_URL: "https://x.test" }, "a=1", "sig")).status).toBe(503);
  });
  it("refuses a missing or wrong signature and oversized bodies", async () => {
    const body = form({ MessageSid: REF, MessageStatus: "delivered" });
    expect((await handleSmsStatusWebhook(db, env, body, null)).status).toBe(403);
    expect((await handleSmsStatusWebhook(db, env, body, "AAAA")).status).toBe(403);
    expect((await handleSmsInboundWebhook(db, env, form({ From: "+61400000000", Body: "STOP" }), null)).status).toBe(403);
    expect((await handleSmsStatusWebhook(db, env, "x".repeat(20_000), null)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it("ignores a status it does not understand, without touching the database", async () => {
    for (const body of [form({ MessageSid: REF, MessageStatus: "weird" }), form({ MessageSid: "nope", MessageStatus: "delivered" })]) {
      const r = await handleSmsStatusWebhook(db, env, body, signed("status", body));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ ignored: true });
    }
    expect(calls).toHaveLength(0);
  });
  it("reports an unknown message reference as unknown", async () => {
    const body = form({ MessageSid: REF, MessageStatus: "delivered" });
    const r = await handleSmsStatusWebhook(db, env, body, signed("status", body));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ outcome: "unknown" });
  });
  it("answers inbound texts with empty TwiML and only acts on stop words", async () => {
    calls.length = 0;
    const hello = form({ From: "+61400000000", Body: "hello" });
    const r = await handleSmsInboundWebhook(db, env, hello, signed("inbound", hello));
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/xml");
    expect(calls).toHaveLength(0);
    const stop = form({ From: "+61400000000", Body: "STOP" });
    await handleSmsInboundWebhook(db, env, stop, signed("inbound", stop));
    expect(calls.some(c => c.includes("buyer_verification"))).toBe(true);
  });
});
