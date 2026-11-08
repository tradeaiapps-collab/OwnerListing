import { describe, expect, it } from "vitest";
import { describeRule, fillTemplate, parseRule } from "../src/domain/staff-automation";
import { campaignStats, canMove, parseCampaign } from "../src/domain/campaigns";
import { describeTask, nextTaskRun, parseTask } from "../src/domain/scheduled-tasks";
import { groupSections } from "../src/domain/admin-nav";
import { sectionsFor } from "../src/domain/staff-admin";

const NOW = "2026-11-05T00:00:00.000Z";
const rule = { name: "Tell the agent", trigger: "offer_received", recipient: "owner_and_agent", title: "Offer on {listing}", body: "Check {listing}." };

describe("workflow rules", () => {
  it("accepts a valid rule and defaults to an account notice", () => {
    const r = parseRule(rule);
    expect(r).toMatchObject({ ok: true, rule: { trigger: "offer_received", messageKind: "system_notice", enabled: true, link: null } });
  });
  it("needs the right settings for each trigger", () => {
    expect(parseRule({ ...rule, trigger: "listing_aging", recipient: "owner" })).toMatchObject({ ok: false });
    expect(parseRule({ ...rule, trigger: "listing_aging", recipient: "owner", triggerConfig: { days: 3 } })).toMatchObject({ ok: false });
    expect(parseRule({ ...rule, trigger: "listing_aging", recipient: "owner", triggerConfig: { days: 90 } })).toMatchObject({ ok: true, rule: { triggerConfig: { days: 90 } } });
    expect(parseRule({ ...rule, trigger: "listing_viewed_repeat", recipient: "buyer", triggerConfig: { views: 3 } })).toMatchObject({ ok: true, rule: { triggerConfig: { views: 3, windowDays: 14 } } });
    expect(parseRule({ ...rule, trigger: "listing_viewed_repeat", recipient: "buyer", triggerConfig: { views: 1 } })).toMatchObject({ ok: false });
  });
  it("refuses a recipient the trigger cannot reach, marketing to non-buyers and off-site links", () => {
    expect(parseRule({ ...rule, trigger: "listing_aging", recipient: "buyer", triggerConfig: { days: 90 } })).toMatchObject({ ok: false });
    expect(parseRule({ ...rule, messageKind: "marketing_news" })).toMatchObject({ ok: false });
    expect(parseRule({ ...rule, trigger: "listing_viewed_repeat", recipient: "buyer", triggerConfig: { views: 3 }, messageKind: "marketing_news" })).toMatchObject({ ok: true });
    expect(parseRule({ ...rule, link: "https://evil.example" })).toMatchObject({ ok: false });
    expect(parseRule({ ...rule, link: "//evil.example" })).toMatchObject({ ok: false });
    expect(parseRule({ ...rule, link: "/listings/mine" })).toMatchObject({ ok: true, rule: { link: "/listings/mine" } });
    expect(parseRule({ ...rule, name: "ab" })).toMatchObject({ ok: false });
    expect(parseRule(null)).toMatchObject({ ok: false });
  });
  it("fills placeholders and describes the rule", () => {
    expect(fillTemplate("{listing} after {days} days, {count} views, {other}", { listing: "1 A St", days: 90, count: 3 })).toBe("1 A St after 90 days, 3 views, {other}");
    expect(describeRule({ trigger: "listing_aging", triggerConfig: { days: 90 }, recipient: "owner" })).toBe("When a listing has been live 90 days, tell the listing owner.");
  });
});

describe("campaigns", () => {
  const email = { name: "Spring news", channel: "email", segment: "all_agents", subject: "Hello", body: "Body" };
  it("accepts an email campaign and needs a subject", () => {
    expect(parseCampaign(email, NOW)).toMatchObject({ ok: true, value: { channel: "email", scheduledAt: null, ctaUrl: null } });
    expect(parseCampaign({ ...email, subject: "" }, NOW)).toMatchObject({ ok: false });
    expect(parseCampaign({ ...email, channel: "sms", subject: undefined }, NOW)).toMatchObject({ ok: true, value: { subject: null } });
  });
  it("limits SMS length, link shape and send time", () => {
    expect(parseCampaign({ ...email, channel: "sms", body: "x".repeat(321) }, NOW)).toMatchObject({ ok: false });
    expect(parseCampaign({ ...email, ctaUrl: "http://plain.example" }, NOW)).toMatchObject({ ok: false });
    expect(parseCampaign({ ...email, ctaUrl: "javascript:alert(1)" }, NOW)).toMatchObject({ ok: false });
    expect(parseCampaign({ ...email, ctaUrl: "https://ok.example/a" }, NOW)).toMatchObject({ ok: true });
    expect(parseCampaign({ ...email, scheduledAt: "2026-11-04T00:00:00Z" }, NOW)).toMatchObject({ ok: false });
    expect(parseCampaign({ ...email, scheduledAt: "2026-11-06T01:00:00Z" }, NOW)).toMatchObject({ ok: true, value: { scheduledAt: "2026-11-06T01:00:00.000Z" } });
    expect(parseCampaign({ ...email, scheduledAt: "not a date" }, NOW)).toMatchObject({ ok: false });
  });
  it("needs an area for the area segment and drops bad suburb names", () => {
    expect(parseCampaign({ ...email, segment: "buyers_in_area" }, NOW)).toMatchObject({ ok: false });
    const r = parseCampaign({ ...email, segment: "buyers_in_area", segmentConfig: { state: "qld", suburbs: ["Paddington", "<script>"] } }, NOW);
    expect(r).toMatchObject({ ok: true, value: { segmentConfig: { state: "QLD", suburbs: ["Paddington"] } } });
  });
  it("computes rates from sent messages and limits status moves", () => {
    expect(campaignStats({ total: 10, sent: 8, failed: 1, skipped: 1, pending: 0, opened: 4, clicked: 1 })).toMatchObject({ openRate: 50, clickRate: 12.5 });
    expect(campaignStats({ total: 0, sent: 0, failed: 0, skipped: 0, pending: 0, opened: 0, clicked: 0 }).openRate).toBe(0);
    expect(canMove("draft", "sending")).toBe(true);
    expect(canMove("sent", "cancelled")).toBe(false);
    expect(canMove("sending", "draft")).toBe(false);
  });
});

describe("scheduled tasks", () => {
  const task = { name: "Tidy up", kind: "archive_stale_listings", config: { days: 365 }, cadence: "daily", hour: 9 };
  it("validates each kind and cadence", () => {
    expect(parseTask(task, NOW)).toMatchObject({ ok: true });
    expect(parseTask({ ...task, config: { days: 5 } }, NOW)).toMatchObject({ ok: false });
    expect(parseTask({ ...task, kind: "invite_reminders", config: {} }, NOW)).toMatchObject({ ok: true });
    expect(parseTask({ ...task, cadence: "once" }, NOW)).toMatchObject({ ok: false });
    expect(parseTask({ ...task, cadence: "once", runAt: "2026-11-06T00:00:00Z" }, NOW)).toMatchObject({ ok: true, value: { runAt: "2026-11-06T00:00:00.000Z" } });
    expect(parseTask({ ...task, hour: 24 }, NOW)).toMatchObject({ ok: false });
    expect(parseTask({ ...task, cadence: "monthly", dayOfMonth: 31 }, NOW)).toMatchObject({ ok: false });
  });
  it("finds the next run in Brisbane time and finishes one-offs", () => {
    // 09:00 Brisbane (UTC+10) is 23:00 UTC the day before.
    expect(nextTaskRun({ cadence: "daily", hour: 9, weekday: null, dayOfMonth: null, runAt: null }, NOW)).toBe("2026-11-05T23:00:00.000Z");
    expect(nextTaskRun({ cadence: "once", hour: 9, weekday: null, dayOfMonth: null, runAt: "2026-12-01T00:00:00.000Z" }, NOW)).toBe("2026-12-01T00:00:00.000Z");
    expect(nextTaskRun({ cadence: "once", hour: 9, weekday: null, dayOfMonth: null, runAt: "2026-12-01T00:00:00.000Z" }, NOW, true)).toBeNull();
    expect(describeTask({ cadence: "weekly", hour: 8, weekday: 2, dayOfMonth: null, runAt: null })).toBe("Every Tuesday at 08:00 Brisbane time");
  });
});

describe("staff navigation", () => {
  it("shows Automation and Campaigns to a super admin and to nobody without the permission", () => {
    const admin = { id: "u1", role: "super_admin" } as never;
    const links = groupSections(sectionsFor(admin)).flatMap(g => g.links.map(l => l.href));
    expect(links).toContain("/staff/automation");
    expect(links).toContain("/staff/campaigns");
    const support = { id: "u2", role: "support" } as never;
    expect(sectionsFor(support).map(s => s.href)).not.toContain("/staff/campaigns");
  });
});
