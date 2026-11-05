import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/domain/email-templates";
import {
  CATEGORIES, CATEGORY_INFO, KINDS, answerNotificationQuestion, consentChanges, defaultPreferences, describeSuggestions, parsePreferencesInput,
  planChannels, renderNotification, resolvePreferences, safeLink, suggestPreferences, summarizeNotifications, type Kind, type NotificationView
} from "../src/domain/notifications";
import { makeNotificationUnsubscribeToken, readNotificationUnsubscribeToken } from "../src/server/notifications-db";

const KEY = "k".repeat(40);
const U = "11111111-1111-4111-8111-111111111111";

describe("preferences", () => {
  it("defaults: in-app on, SMS and marketing off, account locked on", () => {
    const d = defaultPreferences();
    expect(CATEGORIES.every(c => d[c].sms === false)).toBe(true);
    expect(d.marketing).toEqual({ inApp: false, email: false, sms: false });
    expect(d.account.inApp && d.account.email).toBe(true);
    expect(d.offers).toEqual({ inApp: true, email: true, sms: false });
  });
  it("stored rows override defaults but locked channels stay on and SMS stays off where never allowed", () => {
    const p = resolvePreferences([
      { category: "offers", inApp: true, email: false, sms: true },
      { category: "account", inApp: false, email: false, sms: true },
      { category: "nonsense", inApp: false, email: false, sms: false }
    ]);
    expect(p.offers).toEqual({ inApp: true, email: false, sms: true });
    expect(p.account).toEqual({ inApp: true, email: true, sms: false });
  });
  it("parses valid input and refuses unknown keys, non-booleans, locked-off and disallowed SMS", () => {
    const ok = parsePreferencesInput({ preferences: { offers: { inApp: true, email: false, sms: true } } });
    expect(ok).toEqual({ ok: true, value: { offers: { inApp: true, email: false, sms: true } } });
    for (const bad of [null, [], {}, { preferences: [] }, { preferences: { x: {} } }, { extra: 1, preferences: {} },
      { preferences: { offers: { inApp: true, email: "yes", sms: false } } },
      { preferences: { offers: { inApp: true, email: true } } },
      { preferences: { offers: { inApp: true, email: true, sms: false, push: true } } },
      { preferences: { account: { inApp: true, email: false, sms: false } } },
      { preferences: { listings: { inApp: true, email: true, sms: true } } },
      { preferences: { marketing: { inApp: true, email: true, sms: true } } }]) {
      expect(parsePreferencesInput(bad).ok).toBe(false);
    }
  });
  it("lists only flipped channels as consent changes", () => {
    const a = defaultPreferences();
    const b = { ...a, marketing: { inApp: false, email: true, sms: false }, offers: { ...a.offers, sms: true } };
    expect(consentChanges(a, b)).toEqual([
      { category: "offers", channel: "sms", granted: true },
      { category: "marketing", channel: "email", granted: true }
    ]);
    expect(consentChanges(a, a)).toEqual([]);
  });
});

describe("channel planning", () => {
  it("never sends SMS without opt-in, a suitable kind and a verified phone", () => {
    const p = defaultPreferences();
    expect(planChannels("offer_received", p, true).sms).toBe(false);
    const on = { ...p, offers: { ...p.offers, sms: true } };
    expect(planChannels("offer_received", on, true).sms).toBe(true);
    expect(planChannels("offer_received", on, false).sms).toBe(false);
    const msgs = { ...p, messages: { ...p.messages, sms: true } };
    expect(planChannels("message_received", msgs, true).sms).toBe(true);
  });
  it("honours opt-outs and keeps required account notices on", () => {
    const p = { ...defaultPreferences(), offers: { inApp: false, email: false, sms: false } };
    expect(planChannels("offer_accepted", p, false)).toEqual({ inApp: false, email: false, sms: false });
    expect(planChannels("security_notice", p, false)).toMatchObject({ inApp: true, email: true });
    expect(planChannels("marketing_news", defaultPreferences(), true)).toEqual({ inApp: false, email: false, sms: false });
  });
  it("every kind maps to a category", () => {
    for (const k of Object.keys(KINDS) as Kind[]) expect(CATEGORIES).toContain(renderNotification(k).category);
  });
});

describe("wording", () => {
  it("clips, strips control characters and falls back when a value is missing", () => {
    const n = renderNotification("message_received", { name: "A\u0000\nB".repeat(100), listing: "  " });
    expect(n.body).not.toMatch(/[\u0000-\u001f]/);
    expect(n.body.length).toBeLessThan(260);
    expect(n.body).toContain("your property");
  });
  it("accepts only site-relative links", () => {
    expect(safeLink("/offers")).toBe("/offers");
    for (const l of ["//evil.test", "https://evil.test", "javascript:alert(1)", "offers", "/a b", undefined]) expect(safeLink(l as string | undefined)).toBeNull();
  });
  it("texts exist only for time-critical kinds", () => {
    expect(renderNotification("offer_received").smsText).toContain("offer");
    expect(renderNotification("saved_search_match").smsText).toBeNull();
    expect(renderNotification("marketing_news").smsText).toBeNull();
  });
});

describe("email templates", () => {
  it("escapes everything, drops unsafe links and always has a text version", () => {
    const m = renderEmail({ brand: "Own<er>", title: "Hi <script>alert(1)</script>", body: "a & b\nline2", actionUrl: "javascript:alert(1)", reason: "why", settingsUrl: "https://x.test/s?a=1&b=2" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).not.toContain("javascript:");
    expect(m.html).toContain("a &amp; b<br>line2");
    expect(m.html).toContain("a=1&amp;b=2");
    expect(m.text).toContain("a & b");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
  it("shows the button and the unsubscribe link when given", () => {
    const m = renderEmail({ brand: "B", title: "T", body: "x", actionUrl: "https://x.test/o", actionLabel: "Open", reason: "r", unsubscribeUrl: "https://x.test/u?t=1" });
    expect(m.html).toContain('href="https://x.test/o"');
    expect(m.html).toContain("Unsubscribe");
    expect(m.text).toContain("Unsubscribe: https://x.test/u?t=1");
  });
});

describe("unsubscribe token", () => {
  it("round-trips, and fails closed on tamper, other key, short key or other token", () => {
    const t = makeNotificationUnsubscribeToken(U, "marketing", KEY)!;
    expect(readNotificationUnsubscribeToken(t, KEY)).toEqual({ userId: U, category: "marketing" });
    expect(readNotificationUnsubscribeToken(t.slice(0, -2) + "xx", KEY)).toBeUndefined();
    expect(readNotificationUnsubscribeToken(t, "z".repeat(40))).toBeUndefined();
    expect(makeNotificationUnsubscribeToken(U, "marketing", "short")).toBeUndefined();
    expect(readNotificationUnsubscribeToken(t, undefined)).toBeUndefined();
    expect(readNotificationUnsubscribeToken("v1.a.b", KEY)).toBeUndefined();
  });
});

describe("Elena", () => {
  const n = (o: Partial<NotificationView>): NotificationView => ({ id: "i", kind: "offer_received", category: "offers", title: "T", body: "b", link: null, createdAt: "2026-11-01T00:00:00.000Z", readAt: null, archivedAt: null, ...o });
  it("summarises only unread, non-archived items by category", () => {
    const r = summarizeNotifications([
      n({ id: "1", title: "Old offer", createdAt: "2026-11-01T00:00:00.000Z" }),
      n({ id: "2", title: "New offer", link: "/offers", createdAt: "2026-11-02T00:00:00.000Z" }),
      n({ id: "3", category: "messages", title: "Hello" }),
      n({ id: "4", readAt: "2026-11-02T00:00:00.000Z", title: "Read one" }),
      n({ id: "5", archivedAt: "2026-11-02T00:00:00.000Z", title: "Archived" })
    ]);
    expect(r.text).toContain("3 unread notifications");
    expect(r.text).toContain('Offers: 2 new items, latest "New offer"');
    expect(r.text).toContain('Messages: 1 new item');
    expect(r.text).not.toContain("Read one");
    expect(r.links).toEqual([{ label: 'Open "New offer"', href: "/offers" }]);
    expect(summarizeNotifications([]).text).toMatch(/all caught up/);
  });
  it("answers settings questions and refuses advice", () => {
    expect(answerNotificationQuestion("How do I turn off texts?").text).toMatch(/Text messages/);
    expect(answerNotificationQuestion("how do i unsubscribe from marketing").text).toMatch(/unsubscribe link/);
    expect(answerNotificationQuestion("Which notifications are required?").text).toMatch(/required/);
    expect(answerNotificationQuestion("What types of notifications are there?").text).toContain("offers");
    expect(answerNotificationQuestion("Should I accept this offer?").text).toMatch(/can't advise/);
    expect(answerNotificationQuestion("   ").pose).toBe("listening");
    expect(answerNotificationQuestion("zzz qqq").text).toMatch(/not sure/);
  });
  it("suggests quieter email for ignored categories and SMS for well-read ones, never marketing", () => {
    const prefs = defaultPreferences();
    const s = suggestPreferences([
      { category: "listings", total: 20, read: 1 }, // listings email is off by default: nothing to switch off
      { category: "messages", total: 10, read: 1 },
      { category: "offers", total: 10, read: 9 },
      { category: "appointments", total: 3, read: 0 },
      { category: "account", total: 30, read: 0 },
      { category: "marketing", total: 30, read: 30 }
    ], prefs, true);
    expect(s.map(x => `${x.category}:${x.channel}:${x.turnOn}`)).toEqual(["messages:email:false", "offers:sms:true"]);
    expect(suggestPreferences([{ category: "offers", total: 10, read: 9 }], prefs, false)).toEqual([]);
    expect(describeSuggestions([]).text).toMatch(/look right/);
    expect(describeSuggestions(s).text).toContain("Messages:");
    expect(CATEGORY_INFO.marketing.defaults.email).toBe(false);
  });
});
