import { describe, expect, it } from "vitest";
import { nextStatus, overlaps, parseFindings, parseSchedule, reminderDueAt, summariseFindings } from "../src/domain/inspection";

const NOW = "2026-11-05T00:00:00.000Z";
const ok = { kind: "building", scheduledStart: "2026-11-10T01:00:00.000Z", durationMinutes: 90 };

describe("parseSchedule", () => {
  it("accepts a valid booking and normalises the time", () => {
    const r = parseSchedule({ ...ok, scheduledStart: "2026-11-10T11:00:00+10:00", accessNotes: " Key in the lockbox " }, NOW);
    expect(r).toEqual({ ok: true, value: { kind: "building", scheduledStart: "2026-11-10T01:00:00.000Z", durationMinutes: 90, accessNotes: "Key in the lockbox" } });
  });
  it.each([
    [{ ...ok, kind: "roof" }, "Choose a type"],
    [{ ...ok, scheduledStart: "tomorrow" }, "Choose a date"],
    [{ ...ok, scheduledStart: "2026-11-05T00:30:00.000Z" }, "at least an hour"],
    [{ ...ok, scheduledStart: "2027-06-01T00:00:00.000Z" }, "6 months"],
    [{ ...ok, durationMinutes: 5 }, "Duration"],
    [{ ...ok, durationMinutes: 90.5 }, "Duration"],
    [{ ...ok, accessNotes: "<script>" }, "Access notes"],
    [{ ...ok, inspectorUserId: "nope" }, "not valid"],
    ["text", "Choose a type"]
  ])("rejects %j", (body, text) => {
    const r = parseSchedule(body, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(text);
  });
});

describe("nextStatus", () => {
  const withInspector = { status: "requested", inspectorUserId: "i", kind: "building" } as const;
  const walk = { status: "requested", kind: "walkthrough" } as const;
  const later = "2026-11-10T01:00:00.000Z";
  it("lets only the assigned inspector confirm", () => {
    expect(nextStatus(withInspector, "confirm", "inspector", NOW, later)).toEqual({ ok: true, status: "confirmed" });
    expect(nextStatus(withInspector, "confirm", "owner", NOW, later).ok).toBe(false);
    expect(nextStatus(withInspector, "confirm", "buyer", NOW, later).ok).toBe(false);
  });
  it("lets the owner or agent confirm a walkthrough with no inspector", () => {
    expect(nextStatus(walk, "confirm", "owner", NOW, later).ok).toBe(true);
    expect(nextStatus(walk, "confirm", "agent", NOW, later).ok).toBe(true);
    expect(nextStatus(walk, "confirm", "buyer", NOW, later).ok).toBe(false);
  });
  it("cancels only an open inspection", () => {
    expect(nextStatus(withInspector, "cancel", "buyer", NOW, later).ok).toBe(true);
    expect(nextStatus({ ...withInspector, status: "completed" }, "cancel", "owner", NOW, later).ok).toBe(false);
    expect(nextStatus({ ...withInspector, status: "cancelled" }, "cancel", "owner", NOW, later).ok).toBe(false);
  });
  it("completes only after it is confirmed and has started, by the inspector", () => {
    const c = { ...withInspector, status: "confirmed" } as const;
    expect(nextStatus(withInspector, "complete", "inspector", later, later).ok).toBe(false);
    expect(nextStatus(c, "complete", "inspector", NOW, later).ok).toBe(false);
    expect(nextStatus(c, "complete", "owner", later, later).ok).toBe(true);
    expect(nextStatus(c, "complete", "inspector", later, later)).toEqual({ ok: true, status: "completed" });
    expect(nextStatus(c, "complete", "buyer", later, later).ok).toBe(false);
  });
});

describe("findings, reminders and overlap", () => {
  it("validates findings", () => {
    expect(parseFindings(undefined)).toEqual({ ok: true, value: [] });
    expect(parseFindings([{ severity: "major", area: "Roof", summary: "Cracked tiles" }])).toEqual({ ok: true, value: [{ severity: "major", area: "Roof", summary: "Cracked tiles" }] });
    expect(parseFindings([{ severity: "huge", area: "Roof", summary: "x" }]).ok).toBe(false);
    expect(parseFindings([{ severity: "info", area: "", summary: "x" }]).ok).toBe(false);
    expect(parseFindings("nope").ok).toBe(false);
    expect(parseFindings(Array.from({ length: 51 }, () => ({ severity: "info", area: "a", summary: "b" }))).ok).toBe(false);
  });
  it("summarises findings without advice, urgent first", () => {
    const s = summariseFindings([
      { severity: "minor", area: "Door", summary: "Sticks" }, { severity: "major", area: "Roof", summary: "Cracked tiles" }, { severity: "urgent", area: "Wiring", summary: "Exposed" }
    ]);
    expect(s.bySeverity).toEqual({ info: 0, minor: 1, major: 1, urgent: 1 });
    expect(s.priorities.map(p => p.area)).toEqual(["Wiring", "Roof"]);
    expect(s.headline).toContain("3 findings");
    expect(s.nextSteps.join(" ")).not.toMatch(/buy|price|negotiat/i);
    expect(summariseFindings([]).headline).toBe("No findings were recorded.");
  });
  it("sets the reminder 24h before, or none when closer", () => {
    expect(reminderDueAt("2026-11-10T01:00:00.000Z", NOW)).toBe("2026-11-09T01:00:00.000Z");
    expect(reminderDueAt("2026-11-05T10:00:00.000Z", NOW)).toBeNull();
  });
  it("detects overlap but allows back-to-back", () => {
    expect(overlaps("2026-11-10T01:00:00Z", 60, "2026-11-10T01:30:00Z", 60)).toBe(true);
    expect(overlaps("2026-11-10T01:00:00Z", 60, "2026-11-10T02:00:00Z", 60)).toBe(false);
  });
});
