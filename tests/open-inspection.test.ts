import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateOpenSlots, overlaps, parseAgentAction, parseBlock, parseBookingInput, parseRule, whenText, type Rule } from "../src/domain/open-inspection";
import { renderNotification } from "../src/domain/notifications";
import { localDateInZone } from "../src/domain/timezone";

// 2026-11-05 is a Thursday. Sydney is UTC+11 in November.
const NOW = "2026-11-05T00:00:00.000Z";
const weekly = (o: Partial<Rule> = {}): Rule => ({ id: "r1", recurrence: "weekly", dayOfWeek: 6, onDate: null, startMin: 600, endMin: 840, slotMinutes: 30, capacity: 1, endDate: null, ...o });

describe("open inspection rules", () => {
  it("accepts a weekly window with HH:MM times and defaults", () => {
    const r = parseRule({ recurrence: "weekly", dayOfWeek: 6, start: "10:00", end: "14:00", slotMinutes: 30 }, NOW);
    expect(r).toEqual({ ok: true, value: { recurrence: "weekly", dayOfWeek: 6, onDate: null, startMin: 600, endMin: 840, slotMinutes: 30, capacity: 1, endDate: null } });
  });
  it("accepts a one-off date and refuses a past one", () => {
    expect(parseRule({ recurrence: "once", date: "2026-12-10", start: "09:00", end: "12:00", slotMinutes: 30 }, NOW)).toMatchObject({ ok: true, value: { onDate: "2026-12-10", dayOfWeek: null } });
    expect(parseRule({ recurrence: "once", date: "2026-11-04", start: "09:00", end: "12:00" }, NOW)).toMatchObject({ ok: false });
    expect(parseRule({ recurrence: "once", date: "2026-02-30", start: "09:00", end: "12:00" }, NOW)).toMatchObject({ ok: false });
  });
  it.each([
    [{ recurrence: "monthly" }], [{ recurrence: "weekly", dayOfWeek: 7, start: "10:00", end: "11:00" }],
    [{ recurrence: "weekly", dayOfWeek: 1, start: "11:00", end: "10:00" }], [{ recurrence: "weekly", dayOfWeek: 1, start: "10:00", end: "10:20", slotMinutes: 30 }],
    [{ recurrence: "weekly", dayOfWeek: 1, start: "10:00", end: "12:00", slotMinutes: 25 }], [{ recurrence: "weekly", dayOfWeek: 1, start: "10:00", end: "12:00", capacity: 11 }],
    [{ recurrence: "weekly", dayOfWeek: 1, start: "10:00", end: "12:00", endDate: "2020-01-01" }], [null]
  ])("refuses a bad rule %#", input => { expect(parseRule(input, NOW).ok).toBe(false); });
  it("detects overlapping windows on the same day only", () => {
    const a = parseRule({ recurrence: "weekly", dayOfWeek: 6, start: "10:00", end: "12:00" }, NOW); if (!a.ok) throw new Error();
    const mk = (day: number, s: string, e: string) => { const r = parseRule({ recurrence: "weekly", dayOfWeek: day, start: s, end: e }, NOW); if (!r.ok) throw new Error(); return r.value; };
    expect(overlaps(a.value, mk(6, "11:00", "13:00"))).toBe(true);
    expect(overlaps(a.value, mk(6, "12:00", "13:00"))).toBe(false);
    expect(overlaps(a.value, mk(0, "10:00", "12:00"))).toBe(false);
  });
});

describe("open inspection slots", () => {
  it("lists weekly Saturday 10am-2pm in 30 minute slots in the property's time zone", () => {
    const slots = generateOpenSlots([weekly()], [], new Map(), "Australia/Sydney", NOW, 7);
    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual({ startsAt: "2026-11-06T23:00:00.000Z", endsAt: "2026-11-06T23:30:00.000Z", spotsLeft: 1 }); // Sat 7 Nov 10:00 Sydney
    expect(slots[7]!.endsAt).toBe("2026-11-07T03:00:00.000Z"); // 14:00 Sydney
  });
  it("stops a weekly rule at its end date and repeats it weekly", () => {
    const slots = generateOpenSlots([weekly({ endDate: "2026-11-14" })], [], new Map(), "Australia/Sydney", NOW, 28);
    expect([...new Set(slots.map(s => localDateInZone(s.startsAt, "Australia/Sydney")))]).toEqual(["2026-11-07", "2026-11-14"]);
  });
  it("offers a one-off date only on that day", () => {
    const slots = generateOpenSlots([weekly({ recurrence: "once", dayOfWeek: null, onDate: "2026-12-10", startMin: 540, endMin: 720 })], [], new Map(), "Australia/Sydney", NOW, 60);
    expect(slots).toHaveLength(6);
    expect(slots[0]!.startsAt).toBe("2026-12-09T22:00:00.000Z");
  });
  it("hides blocked times, full slots and slots under an hour away", () => {
    const blocks = [{ startsAt: "2026-11-06T23:00:00.000Z", endsAt: "2026-11-07T00:00:00.000Z" }];
    const taken = new Map([["2026-11-07T00:00:00.000Z", 1]]);
    const slots = generateOpenSlots([weekly()], blocks, taken, "Australia/Sydney", NOW, 7);
    expect(slots.map(s => s.startsAt)).not.toContain("2026-11-06T23:00:00.000Z");
    expect(slots.map(s => s.startsAt)).not.toContain("2026-11-06T23:30:00.000Z");
    expect(slots.map(s => s.startsAt)).not.toContain("2026-11-07T00:00:00.000Z");
    expect(slots).toHaveLength(5);
    const soon = generateOpenSlots([weekly()], [], new Map(), "Australia/Sydney", "2026-11-06T22:30:00.000Z", 1);
    expect(soon[0]!.startsAt).toBe("2026-11-06T23:30:00.000Z"); // 10:00 is 30 minutes away, 10:30 is 60
  });
  it("keeps spots left on a slot with capacity above one", () => {
    const slots = generateOpenSlots([weekly({ capacity: 3 })], [], new Map([["2026-11-07T00:00:00.000Z", 2]]), "Australia/Sydney", NOW, 7);
    expect(slots.find(s => s.startsAt === "2026-11-07T00:00:00.000Z")!.spotsLeft).toBe(1);
  });
  it("uses standard time on a winter date", () => {
    const slots = generateOpenSlots([weekly({ recurrence: "once", dayOfWeek: null, onDate: "2027-07-10", startMin: 600, endMin: 630 })], [], new Map(), "Australia/Sydney", "2027-07-01T00:00:00.000Z", 30);
    expect(slots[0]!.startsAt).toBe("2027-07-10T00:00:00.000Z"); // AEST is UTC+10
  });
});

describe("open inspection bookings and actions", () => {
  const good = { startsAt: "2026-11-07T00:00:00.000Z", name: "  Sam  Buyer ", phone: "0412 345 678", email: "sam@example.com", notes: "Interested in the kitchen" };
  it("accepts a booking and tidies it", () => {
    expect(parseBookingInput(good)).toMatchObject({ ok: true, value: { name: "Sam  Buyer", phone: "0412 345 678", notes: "Interested in the kitchen" } });
  });
  it.each([[{ ...good, name: "" }], [{ ...good, startsAt: "soon" }], [{ ...good, phone: "abc", email: "" }], [{ ...good, email: "nope", phone: "" }], [{ ...good, phone: "", email: "" }]])("refuses a bad booking %#", i => {
    expect(parseBookingInput(i).ok).toBe(false);
  });
  it("needs a block to end after it starts and not in the past", () => {
    expect(parseBlock({ startsAt: "2026-11-10T01:00:00Z", endsAt: "2026-11-10T03:00:00Z", note: "Private viewing" }, NOW)).toMatchObject({ ok: true, value: { note: "Private viewing" } });
    expect(parseBlock({ date: "2026-11-14", start: "12:00", end: "13:00" }, NOW, "Australia/Sydney")).toMatchObject({ ok: true, value: { startsAt: "2026-11-14T01:00:00.000Z", endsAt: "2026-11-14T02:00:00.000Z" } });
    expect(parseBlock({ date: "2026-11-14", start: "13:00", end: "12:00" }, NOW).ok).toBe(false);
    expect(parseBlock({ startsAt: "2026-11-10T03:00:00Z", endsAt: "2026-11-10T01:00:00Z" }, NOW).ok).toBe(false);
    expect(parseBlock({ startsAt: "2026-11-01T01:00:00Z", endsAt: "2026-11-01T03:00:00Z" }, NOW).ok).toBe(false);
  });
  it("validates agent actions", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseAgentAction({ ids: [id, id], action: "cancel" })).toEqual({ ok: true, value: { ids: [id], action: "cancel" } });
    expect(parseAgentAction({ ids: [], action: "cancel" }).ok).toBe(false);
    expect(parseAgentAction({ ids: ["x"], action: "cancel" }).ok).toBe(false);
    expect(parseAgentAction({ ids: [id], action: "delete" }).ok).toBe(false);
  });
  it("words the confirmation and reminders with time, address and contact", () => {
    const when = whenText("2026-11-06T23:00:00.000Z", "Australia/Sydney");
    expect(when).toContain("10:00");
    const c = renderNotification("open_inspection_confirmed", { listing: "1 Test St", when, contact: "Alex Agent, alex@example.com", link: "/open-inspections" });
    expect(c.body).toContain("1 Test St"); expect(c.body).toContain("Alex Agent"); expect(c.body).toContain("photo ID"); expect(c.category).toBe("appointments");
    expect(renderNotification("open_inspection_reminder_24h", { listing: "1 Test St", when }).title).toBe("Inspection tomorrow");
    expect(renderNotification("open_inspection_reminder_1h", { listing: "1 Test St", when }).title).toBe("Inspection in 1 hour");
  });
  it("has a 15 minute reminder workflow that calls the route with its own secret", () => {
    const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "open-inspection-reminders.yml"), "utf8");
    expect(wf).toContain('cron: "*/15 * * * *"');
    expect(wf).toContain("/api/internal/open-inspections/reminders");
    expect(wf).toContain("OPEN_INSPECTION_CRON_SECRET");
  });
});
