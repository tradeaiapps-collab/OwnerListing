import { describe, expect, it } from "vitest";
import { createUnconfiguredAlertDelivery } from "../src/adapters/alert-delivery";
import { alertKey, dispatchAlerts, planNewAlerts, type AlertDeliveryPort, type DeliveryLogEntry } from "../src/domain/alerts";
import type { AlertPreference, ListingSummary, SavedSearch } from "../src/domain/buyer";

const listing: ListingSummary = { id: "l1", status: "published", jurisdiction: "QLD", suburb: "New Farm", transactionType: "sale", useClass: "residential", propertyType: "house", priceCents: 120000000, bedrooms: 4 };
const search = (id: string, o: Partial<SavedSearch> = {}): SavedSearch => ({ id, buyerUserId: "b1", transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: [], propertyTypes: [], active: true, ...o });
const consent = (channel: "email" | "sms", o: Partial<AlertPreference> = {}): AlertPreference => ({ channel, consentGivenAt: "2026-01-01T00:00:00Z", ...o });
const none = new Set<string>();

async function run(prefs: Record<string, AlertPreference[]>, port: AlertDeliveryPort, o: { sent?: Set<string>; unsub?: string } = {}) {
  const log: DeliveryLogEntry[] = [];
  const plans = planNewAlerts(listing, [search("s1"), search("s2")], prefs, none);
  const r = await dispatchAlerts(plans, {
    port, prefsByBuyer: prefs, alreadySent: o.sent ?? none,
    unsubscribeUrlFor: () => o.unsub ?? "https://x.test/unsub/t", now: () => "2026-02-01T00:00:00Z",
    log: async e => { log.push(e); }
  });
  return { r, log };
}
const okPort = (calls: unknown[] = []): AlertDeliveryPort => ({ async send(m) { calls.push(m); return "sent"; } });

describe("alert engine", () => {
  it("plans nothing without consent", () => {
    expect(planNewAlerts(listing, [search("s1")], { b1: [{ channel: "email" }] }, none)).toEqual([]);
    expect(planNewAlerts(listing, [search("s1")], {}, none)).toEqual([]);
  });
  it("plans nothing when unsubscribed", () => {
    expect(planNewAlerts(listing, [search("s1")], { b1: [consent("email", { unsubscribedAt: "2026-01-02T00:00:00Z" })] }, none)).toEqual([]);
  });
  it("matches property facts only, one alert per buyer per channel despite several matching searches", () => {
    const p = planNewAlerts(listing, [search("s1"), search("s2"), search("s3", { suburbs: ["Paddington"] })], { b1: [consent("email"), consent("sms")] }, none);
    expect(p.map(a => a.channel).sort()).toEqual(["email", "sms"]);
  });
  it("does not re-plan an alert already sent", () => {
    expect(planNewAlerts(listing, [search("s1")], { b1: [consent("email")] }, new Set([alertKey("b1", "email", "l1")]))).toEqual([]);
  });
  it("sends with an unsubscribe link and logs the attempt", async () => {
    const calls: { unsubscribeUrl: string }[] = [];
    const { r, log } = await run({ b1: [consent("email")] }, okPort(calls));
    expect(r).toHaveLength(1);
    expect(r[0]?.outcome).toBe("sent");
    expect(calls[0]?.unsubscribeUrl).toBe("https://x.test/unsub/t");
    expect(log).toEqual(r);
  });
  it("provider off: nothing is sent, attempts are logged as not_configured", async () => {
    const { r, log } = await run({ b1: [consent("email"), consent("sms")] }, createUnconfiguredAlertDelivery());
    expect(r.map(e => e.outcome)).toEqual(["not_configured", "not_configured"]);
    expect(log).toHaveLength(2);
  });
  it("send-time duplicate is skipped and logged", async () => {
    const calls: unknown[] = [];
    const { r } = await run({ b1: [consent("email")] }, okPort(calls), { sent: new Set([alertKey("b1", "email", "l1")]) });
    expect(r[0]?.outcome).toBe("skipped_duplicate");
    expect(calls).toHaveLength(0);
  });
  it("consent withdrawn between planning and sending blocks the send", async () => {
    const calls: unknown[] = [];
    const plans = planNewAlerts(listing, [search("s1")], { b1: [consent("email")] }, none);
    const r = await dispatchAlerts(plans, { port: okPort(calls), prefsByBuyer: { b1: [consent("email", { unsubscribedAt: "2026-01-05T00:00:00Z" })] }, alreadySent: none, unsubscribeUrlFor: () => "u", now: () => "t", log: async () => {} });
    expect(r[0]?.outcome).toBe("skipped_no_consent");
    expect(calls).toHaveLength(0);
  });
  it("never sends without an unsubscribe link", async () => {
    const calls: unknown[] = [];
    const { r } = await run({ b1: [consent("email")] }, okPort(calls), { unsub: " " });
    expect(r[0]?.outcome).toBe("skipped_no_unsubscribe");
    expect(calls).toHaveLength(0);
  });
  it("a throwing provider is logged as failed", async () => {
    const { r } = await run({ b1: [consent("email")] }, { async send() { throw new Error("boom"); } });
    expect(r[0]?.outcome).toBe("failed");
  });
});
