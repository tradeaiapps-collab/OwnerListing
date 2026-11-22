import { describe, expect, it } from "vitest";
import {
  accessView, buildContractorRows, canSeeAccessDetails, findOverlaps, parseAccessInput, parseComplaint, parseJobPrefs, parseReportRange,
  parseTenantNotice, parseVisitInput, reportCsv, tenantNoticeEmail
} from "../src/domain/contractor-ops";
import { planChannels, defaultPreferences, renderNotification } from "../src/domain/notifications";

const NOW = "2026-12-01T00:00:00.000Z";
const ok = <T>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };

describe("visit time", () => {
  it("accepts a future window with an offset and normalises to UTC", () => {
    const v = ok(parseVisitInput({ startsAt: "2026-12-02T09:00:00+10:00", endsAt: "2026-12-02T10:30:00+10:00", attendees: ["owner", "tenant", "owner"] }, NOW));
    expect(v).toEqual({ startsAt: "2026-12-01T23:00:00.000Z", endsAt: "2026-12-02T00:30:00.000Z", attendees: ["owner", "tenant"] });
  });
  it.each([
    [{ startsAt: "2026-12-02T09:00", endsAt: "2026-12-02T10:00" }, "no zone"],
    [{ startsAt: "2026-11-30T09:00:00Z", endsAt: "2026-11-30T10:00:00Z" }, "past"],
    [{ startsAt: "2026-12-02T09:00:00Z", endsAt: "2026-12-02T09:05:00Z" }, "too short"],
    [{ startsAt: "2026-12-02T09:00:00Z", endsAt: "2026-12-02T22:00:00Z" }, "too long"],
    [{ startsAt: "2028-12-02T09:00:00Z", endsAt: "2028-12-02T10:00:00Z" }, "too far ahead"],
    [{ startsAt: "2026-12-02T09:00:00Z", endsAt: "2026-12-02T10:00:00Z", attendees: ["stranger"] }, "bad attendee"],
    ["nope", "not an object"]
  ] as [unknown, string][])("refuses %j (%s)", (input: unknown) => { expect(parseVisitInput(input, NOW).ok).toBe(false); });
});

describe("double booking", () => {
  const slot = (assignmentId: string, s: string, e: string) => ({ assignmentId, startsAt: s, endsAt: e });
  it("finds overlaps, ignores touching times and the job itself", () => {
    const me = slot("a", "2026-12-02T09:00:00Z", "2026-12-02T10:00:00Z");
    const others = [slot("b", "2026-12-02T09:30:00Z", "2026-12-02T11:00:00Z"), slot("c", "2026-12-02T10:00:00Z", "2026-12-02T11:00:00Z"), slot("a", "2026-12-02T09:00:00Z", "2026-12-02T10:00:00Z")];
    expect(findOverlaps(me, others).map(s => s.assignmentId)).toEqual(["b"]);
  });
});

describe("access details", () => {
  it("needs details for a key or lockbox, and drops them for other methods", () => {
    expect(parseAccessInput({ method: "lockbox" }).ok).toBe(false);
    expect(ok(parseAccessInput({ method: "lockbox", details: " 4821 on the side gate " }))).toEqual({ method: "lockbox", details: "4821 on the side gate" });
    expect(ok(parseAccessInput({ method: "owner_present", details: "ignored" })).details).toBeNull();
    expect(parseAccessInput({ method: "teleport" }).ok).toBe(false);
    expect(parseAccessInput({ method: "key_handover", details: "x".repeat(501) }).ok).toBe(false);
  });
  it("shows details to the owner, and to the contractor only while accepted", () => {
    expect(canSeeAccessDetails("owner", "proposed")).toBe(true);
    for (const s of ["proposed", "completed", "cancelled"]) {
      const v = accessView("lockbox", "4821", "contractor", s);
      expect(v).toMatchObject({ details: null, masked: true, hasDetails: true });
    }
    expect(accessView("lockbox", "4821", "contractor", "approved")).toMatchObject({ details: "4821", masked: false });
  });
});

describe("tenant notice", () => {
  const base = { tenantName: "Sam", tenantEmail: "SAM@Example.com", startsAt: "2026-12-03T09:00:00Z", endsAt: "2026-12-03T11:00:00Z" };
  it("accepts 24 hours' notice and lowercases the email", () => { expect(ok(parseTenantNotice(base, NOW)).tenantEmail).toBe("sam@example.com"); });
  it("refuses short notice, bad email, backwards or very long windows", () => {
    expect(parseTenantNotice({ ...base, startsAt: "2026-12-01T20:00:00Z", endsAt: "2026-12-01T21:00:00Z" }, NOW).ok).toBe(false);
    expect(parseTenantNotice({ ...base, tenantEmail: "nope" }, NOW).ok).toBe(false);
    expect(parseTenantNotice({ ...base, endsAt: base.startsAt }, NOW).ok).toBe(false);
    expect(parseTenantNotice({ ...base, endsAt: "2026-12-04T09:00:00Z" }, NOW).ok).toBe(false);
  });
  it("never puts a code, phone or contractor email in the notice", () => {
    const m = tenantNoticeEmail({ tenantName: "Sam", address: "1 Main St", kind: "photographer", contractorName: "Pat", when: "Thu 9am", ownerName: "Olive", brand: "OwnerListing" });
    expect(m.text).toContain("1 Main St");
    expect(m.text).not.toMatch(/@|\d{4,}/);
  });
});

describe("complaints and preferences", () => {
  it("validates a complaint", () => {
    expect(parseComplaint({ kind: "no_show", details: "  Did not come  " })).toEqual({ ok: true, value: { kind: "no_show", details: "Did not come" } });
    expect(parseComplaint({ kind: "rude", details: "x" }).ok).toBe(false);
    expect(parseComplaint({ kind: "late", details: "  " }).ok).toBe(false);
  });
  it("validates preferences", () => {
    expect(parseJobPrefs({ email: true, sms: false, reminderHours: 2 }).ok).toBe(true);
    expect(parseJobPrefs({ email: true, sms: false, reminderHours: 5 }).ok).toBe(false);
    expect(parseJobPrefs({ email: "yes", sms: false, reminderHours: 2 }).ok).toBe(false);
  });
});

describe("job notifications", () => {
  it("renders and goes by text only when the account allows it", () => {
    for (const k of ["job_new", "job_time_changed", "job_reminder"] as const) {
      expect(renderNotification(k, { listing: "1 Main St", job: "photographer", when: "Thu 9am", link: "/x" })).toMatchObject({ category: "appointments", link: "/x" });
    }
    const prefs = defaultPreferences();
    expect(planChannels("job_new", prefs, true).sms).toBe(false);
    prefs.appointments.sms = true;
    expect(planChannels("job_new", prefs, true).sms).toBe(true);
    expect(planChannels("job_new", prefs, false).sms).toBe(false);
  });
});

describe("staff report", () => {
  const f = (name: string, o: Partial<Parameters<typeof buildContractorRows>[0][number]> = {}) => ({
    contractorId: name, name, invited: 4, accepted: 3, declined: 1, completed: 2, cancelledAfterAccept: 1, responseMinutesTotal: 120, responses: 4, complaints: 0, ...o
  });
  it("computes rates and sorts complaints first", () => {
    const rows = buildContractorRows([f("Ann"), f("Bob", { complaints: 2 }), f("Cy", { invited: 0, accepted: 0, responses: 0, completed: 0 })]);
    expect(rows.map(r => r.name)).toEqual(["Bob", "Ann", "Cy"]);
    expect(rows[1]).toMatchObject({ avgResponseMinutes: 30, completionRate: 66.7, acceptRate: 75 });
    expect(rows[2]).toMatchObject({ avgResponseMinutes: null, completionRate: null, acceptRate: null });
  });
  it("parses ranges", () => {
    expect(parseReportRange(null, null, "2026-11-20")).toEqual({ ok: true, value: { from: "2026-08-23", to: "2026-11-20" } });
    expect(parseReportRange("2026-11-21", "2026-11-20", "2026-11-20").ok).toBe(false);
    expect(parseReportRange("2026-02-30", "2026-03-01", "2026-11-20").ok).toBe(false);
    expect(parseReportRange("2024-01-01", "2026-01-01", "2026-11-20").ok).toBe(false);
  });
  it("exports one CSV row per contractor with the label function applied", () => {
    const { header, rows } = reportCsv(buildContractorRows([f("Ann")]), (n, i) => `${n[0]}. #${i}`);
    expect(header).toHaveLength(rows[0]!.length);
    expect(rows[0]![0]).toBe("A. #0");
  });
});
