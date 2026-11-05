import { describe, expect, it } from "vitest";
import {
  generateSlots, parseAvailability, parseBooking, parseBrowse, parseMarketplaceProfile, parsePortfolioItem, parseReview, ratingSummary, shortName, zonedToUtc
} from "../src/domain/agent-marketplace";
import { renderNotification } from "../src/domain/notifications";

const base = { listed: true, headline: "Bayside specialist", consultModes: ["phone"], availability: [{ weekday: 1, startMin: 540, endMin: 720 }] };

describe("marketplace profile", () => {
  it("accepts a valid profile and normalises lists", () => {
    const r = parseMarketplaceProfile({ ...base, specialties: ["Investors", "investors", " Luxury "], languages: ["English"], yearsExperience: 8 });
    expect(r).toMatchObject({ ok: true, value: { specialties: ["investors", "luxury"], timezone: "Australia/Brisbane", consultMinutes: 30 } });
  });
  it("refuses non-https links, video without a link, bad minutes and overlapping hours", () => {
    expect(parseMarketplaceProfile({ ...base, photoUrl: "http://x.test/a.jpg" })).toMatchObject({ ok: false });
    expect(parseMarketplaceProfile({ ...base, photoUrl: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(parseMarketplaceProfile({ ...base, consultModes: ["video"] })).toMatchObject({ ok: false });
    expect(parseMarketplaceProfile({ ...base, consultModes: ["video"], videoUrl: "https://meet.example.test/room" })).toMatchObject({ ok: true });
    expect(parseMarketplaceProfile({ ...base, consultMinutes: 20 })).toMatchObject({ ok: false });
    expect(parseMarketplaceProfile({ ...base, timezone: "Europe/Paris" })).toMatchObject({ ok: false });
    expect(parseAvailability([{ weekday: 1, startMin: 540, endMin: 660 }, { weekday: 1, startMin: 600, endMin: 720 }], 30)).toMatchObject({ ok: false });
    expect(parseAvailability([{ weekday: 7, startMin: 0, endMin: 60 }], 30)).toMatchObject({ ok: false });
    expect(parseAvailability([{ weekday: 1, startMin: 540, endMin: 555 }], 30)).toMatchObject({ ok: false });
  });
});

describe("slots", () => {
  // 2026-11-02 is a Monday. Brisbane is UTC+10 with no daylight saving.
  const mon = [{ weekday: 1, startMin: 540, endMin: 660 }];
  it("converts a wall-clock time in the agent's timezone", () => {
    expect(new Date(zonedToUtc("Australia/Brisbane", 2026, 11, 2, 540)).toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(new Date(zonedToUtc("Australia/Sydney", 2026, 11, 2, 540)).toISOString()).toBe("2026-11-01T22:00:00.000Z"); // AEDT, UTC+11
  });
  it("offers whole slots inside the hours, after the lead time, skipping booked ones", () => {
    const now = "2026-11-02T00:00:00.000Z"; // Monday 10:00 Brisbane, so this Monday's window has passed
    const slots = generateSlots(mon, "Australia/Brisbane", 30, [], now, 8);
    expect(slots.map(s => s.startsAt)).toEqual(["2026-11-08T23:00:00.000Z", "2026-11-08T23:30:00.000Z", "2026-11-09T00:00:00.000Z", "2026-11-09T00:30:00.000Z"]);
    const busy = [{ startsAt: "2026-11-08T23:30:00.000Z", endsAt: "2026-11-09T00:00:00.000Z" }];
    expect(generateSlots(mon, "Australia/Brisbane", 30, busy, now, 8).map(s => s.startsAt)).not.toContain("2026-11-08T23:30:00.000Z");
  });
  it("respects the two hour lead time", () => {
    const now = "2026-11-01T22:00:00.000Z"; // Monday 08:00 Brisbane; 09:00 and 09:30 are inside the lead time
    const first = generateSlots(mon, "Australia/Brisbane", 30, [], now, 1)[0];
    expect(first?.startsAt).toBe("2026-11-02T00:00:00.000Z"); // 10:00 Brisbane
  });
  it("blocks a longer booking that overlaps a shorter neighbour", () => {
    const busy = [{ startsAt: "2026-11-01T23:30:00.000Z", endsAt: "2026-11-02T00:00:00.000Z" }];
    const slots = generateSlots(mon, "Australia/Brisbane", 60, busy, "2026-10-30T00:00:00.000Z", 5);
    expect(slots.map(s => s.startsAt)).toEqual(["2026-11-02T00:00:00.000Z"]); // 09:00 and 09:30 overlap the busy half hour; 10:00 fits
  });
});

describe("bookings, reviews, portfolio, browse", () => {
  it("validates a booking", () => {
    expect(parseBooking({ startsAt: "2026-11-09T00:00:00Z", mode: "video" })).toMatchObject({ ok: true, value: { startsAt: "2026-11-09T00:00:00.000Z", phone: null } });
    expect(parseBooking({ startsAt: "nope", mode: "video" })).toMatchObject({ ok: false });
    expect(parseBooking({ startsAt: "2026-11-09T00:00:00Z", mode: "phone" })).toMatchObject({ ok: false });
    expect(parseBooking({ startsAt: "2026-11-09T00:00:00Z", mode: "phone", phone: "0412 345 678" })).toMatchObject({ ok: true });
    expect(parseBooking({ startsAt: "2026-11-09T00:00:00Z", mode: "phone", phone: "call me" })).toMatchObject({ ok: false });
    expect(parseBooking({ startsAt: "2026-11-09T00:00:00Z", mode: "fax" })).toMatchObject({ ok: false });
  });
  it("validates reviews and summarises ratings", () => {
    expect(parseReview({ rating: 5 })).toMatchObject({ ok: true });
    expect(parseReview({ rating: 6 })).toMatchObject({ ok: false });
    expect(parseReview({ rating: 1, body: "bad" })).toMatchObject({ ok: false });
    expect(ratingSummary([5, 4, 4])).toMatchObject({ count: 3, average: 4.3, distribution: { 5: 1, 4: 2 } });
    expect(ratingSummary([])).toMatchObject({ count: 0, average: null });
    expect(shortName("Alex Morgan")).toBe("Alex M.");
    expect(shortName("")).toBe("A buyer");
  });
  it("validates portfolio entries and browse filters", () => {
    expect(parsePortfolioItem({ suburb: "Paddington", soldOn: "2026-05-01" }, "2026-11-05T00:00:00Z")).toMatchObject({ ok: true, value: { propertyType: "house", priceCents: null } });
    expect(parsePortfolioItem({ suburb: "Paddington", soldOn: "2027-01-01" }, "2026-11-05T00:00:00Z")).toMatchObject({ ok: false });
    expect(parsePortfolioItem({ suburb: "", soldOn: "2026-05-01" }, "2026-11-05T00:00:00Z")).toMatchObject({ ok: false });
    expect(parsePortfolioItem({ suburb: "X", soldOn: "2026-05-01", priceCents: -5 }, "2026-11-05T00:00:00Z")).toMatchObject({ ok: false });
    expect(parseBrowse(new URLSearchParams("q=Alex&minRating=4&sort=reviews&page=2&mode=video"))).toMatchObject({ q: "Alex", minRating: 4, sort: "reviews", page: 2, mode: "video" });
    expect(parseBrowse(new URLSearchParams("minRating=9&sort=drop&page=-3&mode=x"))).toMatchObject({ minRating: 0, sort: "rating", page: 1, mode: "" });
  });
  it("words the notifications", () => {
    expect(renderNotification("consultation_booked", { name: "Sam", when: "Mon 9 Nov, 9:00 am AEST", link: "/agent/marketplace" })).toMatchObject({ title: "New consultation booked", link: "/agent/marketplace" });
    expect(renderNotification("consultation_confirmed", { name: "Alex" }).body).toContain("Alex");
  });
});
