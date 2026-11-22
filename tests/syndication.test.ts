import { describe, expect, it } from "vitest";
import {
  buildIcal, buildPortalPayload, ineligibleReason, nextAttemptAt, nights, overlaps, parseIncomingBooking, parseListingPortalInput, parsePortalConfig,
  parseIcal, payloadHash, portalReady, safeError, validateBaseUrl, validateCalendarUrl, type SyndicationListing
} from "../src/domain/syndication";

const listing: SyndicationListing = {
  id: "11111111-1111-4111-8111-111111111111", title: "Beach shack", description: "Close to the sand", propertyType: "house", transactionType: "rent",
  address: "1 Shore Rd", suburb: "Noosa", state: "QLD", bedrooms: 2, priceCents: 90_000, updatedAt: "2026-11-05T00:00:00.000Z",
  photoUrls: ["https://x.test/a.jpg"], listingUrl: "https://x.test/listings/1"
};

describe("syndication rules", () => {
  it("accepts only public https partner addresses", () => {
    expect(validateBaseUrl("https://api.vrbo-partner.example/v1/")).toEqual({ ok: true, value: "https://api.vrbo-partner.example/v1" });
    for (const bad of ["http://api.example.com", "https://127.0.0.1/x", "https://user:pw@api.example.com", "https://api.example.com:8443", "https://localhost", "https://api.example.com/?a=1", 5])
      expect(validateBaseUrl(bad).ok, String(bad)).toBe(false);
  });

  it("validates portal config changes", () => {
    expect(parsePortalConfig({ portal: "vrbo", enabled: true, maxPerMinute: 10, allowedTransactionTypes: ["rent", "rent"] })).toEqual({ ok: true, value: { enabled: true, maxPerMinute: 10, allowedTransactionTypes: ["rent"] } });
    expect(parsePortalConfig({ maxPerMinute: 0 }).ok).toBe(false);
    expect(parsePortalConfig({ allowedTransactionTypes: [] }).ok).toBe(false);
    expect(parsePortalConfig({ mode: "ftp" }).ok).toBe(false);
  });

  it("needs address, key and webhook secret before an api portal is ready", () => {
    const base = { enabled: true, mode: "api" as const, baseUrl: "https://a.example", hasKey: true, hasWebhookSecret: true };
    expect(portalReady(base)).toBe(true);
    expect(portalReady({ ...base, hasKey: false })).toBe(false);
    expect(portalReady({ ...base, hasWebhookSecret: false })).toBe(false);
    expect(portalReady({ ...base, baseUrl: null })).toBe(false);
    expect(portalReady({ ...base, enabled: false })).toBe(false);
    expect(portalReady({ ...base, mode: "manual", hasKey: false, baseUrl: null })).toBe(true);
  });

  it("validates per-listing custom fields", () => {
    const ok = parseListingPortalInput({ enabled: true, custom: { houseRules: " No pets ", cancellationPolicy: "strict", minNights: 2, maxGuests: 4 }, manualUrl: "https://airbnb.example/rooms/1#x" });
    expect(ok).toEqual({ ok: true, value: { enabled: true, custom: { houseRules: "No pets", cancellationPolicy: "strict", minNights: 2, maxGuests: 4 }, manualUrl: "https://airbnb.example/rooms/1" } });
    expect(parseListingPortalInput({ enabled: "yes" }).ok).toBe(false);
    expect(parseListingPortalInput({ enabled: true, custom: { cancellationPolicy: "whenever" } }).ok).toBe(false);
    expect(parseListingPortalInput({ enabled: true, custom: { minNights: 0 } }).ok).toBe(false);
    expect(parseListingPortalInput({ enabled: true, custom: { secret: 1 } }).ok).toBe(false);
    expect(parseListingPortalInput({ enabled: true, manualUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(parseListingPortalInput({ enabled: true, manualUrl: "http://plain.example" }).ok).toBe(false);
  });

  it("builds a payload without owner details and hashes it stably", () => {
    const p = buildPortalPayload(listing, { houseRules: "Quiet", minNights: 3 });
    expect(p).toMatchObject({ externalRef: listing.id, title: "Beach shack", houseRules: "Quiet", minNights: 3, cancellationPolicy: null, photos: ["https://x.test/a.jpg"] });
    expect(Object.keys(p)).not.toContain("ownerUserId");
    expect(payloadHash(p)).toBe(payloadHash(buildPortalPayload(listing, { houseRules: "Quiet", minNights: 3 })));
    expect(payloadHash(p)).not.toBe(payloadHash(buildPortalPayload({ ...listing, title: "Other" }, { houseRules: "Quiet", minNights: 3 })));
  });

  it("only shares published listings in an allowed category", () => {
    expect(ineligibleReason({ status: "published", transactionType: "rent" }, ["rent"])).toBeNull();
    expect(ineligibleReason({ status: "draft", transactionType: "rent" }, ["rent"])).toMatch(/published/);
    expect(ineligibleReason({ status: "suspended", transactionType: "rent" }, ["rent"])).toMatch(/published/);
    expect(ineligibleReason({ status: "published", transactionType: "sale" }, ["rent"])).toMatch(/sale/);
  });

  it("backs off 1m, 5m, 30m, 2h, 6h then stops", () => {
    const now = "2026-11-05T00:00:00.000Z";
    expect([1, 2, 3, 4, 5].map(n => (Date.parse(nextAttemptAt(now, n)!) - Date.parse(now)) / 1000)).toEqual([60, 300, 1800, 7200, 21600]);
    expect(nextAttemptAt(now, 6)).toBeNull();
  });

  it("keeps secrets out of stored errors", () => {
    expect(safeError(new Error("bad key sk_live_123456 and Bearer abcdef"), ["sk_live_123456"])).toBe("bad key *** and Bearer ***");
    expect(safeError("x".repeat(500)).length).toBe(300);
  });

  it("parses bookings strictly", () => {
    const base = { event: "booking.created", externalListingId: "L1", externalBookingId: "B1", guestName: "Sam", guests: 2, checkIn: "2026-12-01", checkOut: "2026-12-04", totalCents: 123_00 };
    expect(parseIncomingBooking(base)).toMatchObject({ ok: true, value: { guestName: "Sam", checkIn: "2026-12-01" } });
    expect(parseIncomingBooking({ ...base, checkOut: "2026-12-01" }).ok).toBe(false);
    expect(parseIncomingBooking({ ...base, checkIn: "2026-02-30" }).ok).toBe(false);
    expect(parseIncomingBooking({ ...base, checkOut: "2028-12-04" }).ok).toBe(false);
    expect(parseIncomingBooking({ ...base, event: "booking.deleted" }).ok).toBe(false);
    expect(parseIncomingBooking({ ...base, totalCents: -1 }).ok).toBe(false);
    expect(parseIncomingBooking({ ...base, guestName: undefined })).toMatchObject({ ok: true, value: { guestName: "Guest" } });
    expect(nights("2026-12-01", "2026-12-04")).toBe(3);
  });

  it("treats same-day turnover as no clash", () => {
    expect(overlaps({ checkIn: "2026-12-01", checkOut: "2026-12-04" }, { checkIn: "2026-12-04", checkOut: "2026-12-06" })).toBe(false);
    expect(overlaps({ checkIn: "2026-12-01", checkOut: "2026-12-04" }, { checkIn: "2026-12-03", checkOut: "2026-12-06" })).toBe(true);
  });

  it("builds an iCal feed with dates only", () => {
    const ics = buildIcal("Beach, shack", [{ id: "b1", checkIn: "2026-12-01", checkOut: "2026-12-04" }], "2026-11-05T01:02:03.000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261201");
    expect(ics).toContain("DTEND;VALUE=DATE:20261204");
    expect(ics).toContain("DTSTAMP:20261105T010203Z");
    expect(ics).toContain("X-WR-CALNAME:Beach  shack");
    expect(ics).not.toMatch(/Sam|guest/i);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("accepts only each portal's own https calendar host", () => {
    expect(validateCalendarUrl("airbnb", "https://www.airbnb.com.au/calendar/ical/123.ics?s=abc#x")).toEqual({ ok: true, value: "https://www.airbnb.com.au/calendar/ical/123.ics?s=abc" });
    expect(validateCalendarUrl("booking_com", "https://ical.booking.com/v1/export?t=abc").ok).toBe(true);
    expect(validateCalendarUrl("vrbo", "https://www.vrbo.com/icalendar/abc.ics").ok).toBe(true);
    for (const bad of ["http://www.airbnb.com/x.ics", "https://evil.example/airbnb.com/x.ics", "https://airbnb.com.evil.example/x.ics", "https://notairbnb.com/x.ics",
      "https://user:pw@www.airbnb.com/x", "https://127.0.0.1/x.ics", "https://www.airbnb.com:8443/x.ics", "", 5])
      expect(validateCalendarUrl("airbnb", bad).ok, String(bad)).toBe(false);
    expect(validateCalendarUrl("vrbo", "https://www.airbnb.com/x.ics").ok).toBe(false);
  });

  it("reads blocked stays from iCal and ignores names, notes, cancelled and broken events", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:a1", "DTSTART;VALUE=DATE:20261210", "DTEND;VALUE=DATE:20261214", "SUMMARY:Reserved - Sam Smith", "DESCRIPTION:Phone 0400 000 000", "END:VEVENT",
      "BEGIN:VEVENT", "UID:a0", "DTSTART:20261201T140000Z", "DTEND:20261203T100000Z", "SUMMARY:Airbnb (Not available)", "END:VEVENT",
      "BEGIN:VEVENT", "UID:gone", "DTSTART;VALUE=DATE:20261220", "DTEND;VALUE=DATE:20261222", "STATUS:CANCELLED", "END:VEVENT",
      "BEGIN:VEVENT", "UID:bad", "DTSTART;VALUE=DATE:20261399", "END:VEVENT",
      "BEGIN:VEVENT", "UID:noend", "DTSTART;VALUE=DATE:20261230", "END:VEVENT",
      "BEGIN:VEVENT", "UID:long", "DTSTART;VALUE=DATE:20270101", "DTEND;VALUE=DATE:20280601", "END:VEVENT",
      "BEGIN:VEVENT", "UID:a1", "DTSTART;VALUE=DATE:20261210", "DTEND;VALUE=DATE:20261214", "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    expect(parseIcal(ics)).toEqual([
      { uid: "a0", checkIn: "2026-12-01", checkOut: "2026-12-03" },
      { uid: "a1", checkIn: "2026-12-10", checkOut: "2026-12-14" },
      { uid: "noend", checkIn: "2026-12-30", checkOut: "2026-12-31" },
      { uid: "long", checkIn: "2027-01-01", checkOut: "2028-01-01" }
    ]);
    expect(JSON.stringify(parseIcal(ics))).not.toMatch(/Sam|0400/);
  });

  it("unfolds long lines and refuses text that is not a calendar", () => {
    expect(parseIcal("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:very-long-\r\n id\r\nDTSTART;VALUE=DATE:20261210\r\nDTEND;VALUE=DATE:20261211\r\nEND:VEVENT\r\nEND:VCALENDAR")).toEqual([{ uid: "very-long-id", checkIn: "2026-12-10", checkOut: "2026-12-11" }]);
    expect(parseIcal("<html>Access denied</html>")).toBeNull();
    expect(parseIcal("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toEqual([]);
  });
});
