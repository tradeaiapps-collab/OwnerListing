import { describe, expect, it } from "vitest";
import { compareLeads, followupAt, followupDue, formatResponseTime, leadTone, parseLost, parseNoteText, responseMinutes, type LeadTiming } from "../src/domain/agent-leads";
import { renderNotification } from "../src/domain/notifications";

const NOW = "2026-11-05T10:00:00.000Z";
const base: LeadTiming = { status: "new_inquiry", firstResponseAt: null, lastBuyerAt: "2026-11-05T08:00:00Z", lastAgentAt: null, nextFollowupAt: null };

describe("lead tone", () => {
  it("is red until the agent has replied", () => expect(leadTone(base, NOW)).toBe("red"));
  it("is yellow when the buyer wrote after the agent's last reply", () =>
    expect(leadTone({ ...base, firstResponseAt: "2026-11-05T08:30:00Z", lastAgentAt: "2026-11-05T08:30:00Z", lastBuyerAt: "2026-11-05T09:00:00Z" }, NOW)).toBe("yellow"));
  it("is green when the agent has the last word", () =>
    expect(leadTone({ ...base, firstResponseAt: "2026-11-05T08:30:00Z", lastAgentAt: "2026-11-05T09:30:00Z" }, NOW)).toBe("green"));
  it("turns a green lead red once its follow-up is overdue", () => {
    const l = { ...base, firstResponseAt: "2026-11-05T08:30:00Z", lastAgentAt: "2026-11-05T09:30:00Z", nextFollowupAt: "2026-11-05T09:45:00Z" };
    expect(leadTone(l, NOW)).toBe("red");
    expect(leadTone({ ...l, nextFollowupAt: "2026-11-06T09:00:00Z" }, NOW)).toBe("green");
  });
  it("is closed for lost and converted leads, which never have a due follow-up", () => {
    for (const status of ["lost", "converted"] as const) {
      expect(leadTone({ ...base, status, nextFollowupAt: "2026-11-01T00:00:00Z" }, NOW)).toBe("closed");
      expect(followupDue({ status, nextFollowupAt: "2026-11-01T00:00:00Z" }, NOW)).toBe(false);
    }
  });
  it("sorts the most urgent first, then the longest waiting", () => {
    const red = { ...base, lastInteractionAt: "2026-11-05T09:00:00Z" };
    const older = { ...base, lastInteractionAt: "2026-11-04T09:00:00Z" };
    const green = { ...base, firstResponseAt: "2026-11-05T08:30:00Z", lastAgentAt: "2026-11-05T09:30:00Z", lastInteractionAt: "2026-11-01T00:00:00Z" };
    expect([green, red, older].sort((a, b) => compareLeads(a, b, NOW))).toEqual([older, red, green]);
  });
});

describe("response time", () => {
  it("measures minutes to the first reply", () => expect(responseMinutes("2026-11-05T08:00:00Z", "2026-11-05T08:45:00Z")).toBe(45));
  it("is undefined until the agent replies and never negative", () => {
    expect(responseMinutes("2026-11-05T08:00:00Z", null)).toBeUndefined();
    expect(responseMinutes("2026-11-05T08:00:00Z", "2026-11-05T07:59:00Z")).toBe(0);
  });
  it("reads naturally", () => {
    expect(formatResponseTime(undefined)).toBe("No reply yet");
    expect(formatResponseTime(0)).toBe("Under a minute");
    expect(formatResponseTime(45)).toBe("45 min");
    expect(formatResponseTime(180)).toBe("3 h");
    expect(formatResponseTime(60 * 24 * 5)).toBe("5 days");
  });
});

describe("inputs", () => {
  it("offers only the listed follow-up gaps", () => {
    expect(followupAt(NOW, 3)).toBe("2026-11-08T10:00:00.000Z");
    expect(followupAt(NOW, 4)).toBeUndefined();
    expect(followupAt(NOW, -1)).toBeUndefined();
  });
  it("rejects empty and oversized notes and trims the rest", () => {
    expect(parseNoteText("   ").ok).toBe(false);
    expect(parseNoteText(5).ok).toBe(false);
    expect(parseNoteText("x".repeat(1001)).ok).toBe(false);
    expect(parseNoteText("  cracks  ")).toEqual({ ok: true, text: "cracks" });
  });
  it("needs a known lost reason, and a description for other", () => {
    expect(parseLost("price", "")).toMatchObject({ ok: false });
    expect(parseLost("other", " ")).toMatchObject({ ok: false });
    expect(parseLost("budget", "")).toEqual({ ok: true, reason: "budget", note: "" });
    expect(parseLost("other", "moved interstate")).toEqual({ ok: true, reason: "other", note: "moved interstate" });
  });
  it("renders the reminder as an in-app notification, never as an SMS", () => {
    const n = renderNotification("lead_followup_due", { text: "Follow up with Sam about 1 Test St.", link: "/agent/leads/abc" });
    expect(n).toMatchObject({ category: "messages", title: "Lead follow-up due", link: "/agent/leads/abc", smsText: null });
  });
});
