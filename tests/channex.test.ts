import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAri, buildChannexContent, channelScreenUrl, channexCall, channexConfig, ensureStructure, parseChannexRevision, portalForChannel, verifyChannexWebhook
} from "../src/adapters/portals/channex";

const KEY = "chx-key-0123456789abcdef";
const listing = { title: "Beach shack", description: "Sea views", address: "1 Ocean St", suburb: "Noosa", state: "QLD", propertyType: "house", bedrooms: 2, priceCents: 70_000, photoUrls: ["https://app.example/p/1", "http://insecure/x"] };

describe("channex config", () => {
  it("is off without a usable key, staging unless told production, and only keeps a long webhook secret", () => {
    expect(channexConfig({})).toBeNull();
    expect(channexConfig({ CHANNEX_API_KEY: "short" })).toBeNull();
    expect(channexConfig({ CHANNEX_API_KEY: KEY })).toEqual({ host: "https://staging.channex.io", apiKey: KEY, webhookSecret: null });
    expect(channexConfig({ CHANNEX_API_KEY: KEY, CHANNEX_ENV: "production", CHANNEX_WEBHOOK_SECRET: "x".repeat(32) })).toMatchObject({ host: "https://app.channex.io", webhookSecret: "x".repeat(32) });
    expect(channexConfig({ CHANNEX_API_KEY: KEY, CHANNEX_WEBHOOK_SECRET: "too-short" })?.webhookSecret).toBeNull();
  });
});

describe("channex content and calendar", () => {
  it("uses the owner's nightly price, else a seventh of the weekly rent, and only https photos", () => {
    const c = buildChannexContent(listing, {});
    expect(c).toMatchObject({ nightlyRateCents: 10_000, timezone: "Australia/Brisbane", propertyType: "villa", maxGuests: 4, minNights: 1, photos: ["https://app.example/p/1"] });
    expect(buildChannexContent(listing, { nightlyRateCents: 25_000, minNights: 3, maxGuests: 6 })).toMatchObject({ nightlyRateCents: 25_000, minNights: 3, maxGuests: 6 });
    expect(buildChannexContent({ ...listing, priceCents: null }, {}).nightlyRateCents).toBeNull();
  });

  it("closes booked nights (check-out day stays free) and sends one price range", () => {
    const ids = { propertyId: "P", roomTypeId: "R", ratePlanId: "RP" };
    const ari = buildAri(ids, "2026-11-05", { nightlyRateCents: 10_000, minNights: 2 }, [{ checkIn: "2026-11-07", checkOut: "2026-11-09" }, { checkIn: "2026-10-01", checkOut: "2026-11-06" }]);
    expect(ari.availability.slice(0, 4)).toEqual([
      { property_id: "P", room_type_id: "R", date_from: "2026-11-05", date_to: "2026-11-05", availability: 0 },
      { property_id: "P", room_type_id: "R", date_from: "2026-11-06", date_to: "2026-11-06", availability: 1 },
      { property_id: "P", room_type_id: "R", date_from: "2026-11-07", date_to: "2026-11-08", availability: 0 },
      { property_id: "P", room_type_id: "R", date_from: "2026-11-09", date_to: "2027-11-04", availability: 1 }
    ]);
    expect(ari.availability).toHaveLength(4);
    expect(ari.restrictions).toEqual([{ property_id: "P", rate_plan_id: "RP", date_from: "2026-11-05", date_to: "2027-11-04", rate: 10_000, min_stay_arrival: 2, stop_sell: false }]);
    const closed = buildAri(ids, "2026-11-05", null, [], true);
    expect(closed).toEqual({ availability: [{ property_id: "P", room_type_id: "R", date_from: "2026-11-05", date_to: "2027-11-04", availability: 0 }], restrictions: [] });
  });
});

describe("channex booking revisions", () => {
  const rev = {
    type: "booking_revision", id: "rev-1",
    attributes: {
      property_id: "P", booking_id: "B1", ota_name: "Booking.com", status: "new", arrival_date: "2026-12-01", departure_date: "2026-12-04",
      customer: { name: "Ann", surname: "Lee" }, occupancy: { adults: 2, children: 1, infants: 1 }, amount: "450.50", currency: "AUD"
    }
  };
  it("maps a revision to a stay, keeping money only in AUD", () => {
    expect(parseChannexRevision(rev)).toEqual({ ok: true, value: { revisionId: "rev-1", bookingId: "B1", propertyId: "P", portal: "booking_com", status: "new", checkIn: "2026-12-01", checkOut: "2026-12-04", guestName: "Ann Lee", guests: 3, totalCents: 45_050 } });
    const usd = parseChannexRevision({ ...rev, attributes: { ...rev.attributes, currency: "USD", ota_name: "Airbnb" } });
    expect(usd.ok && usd.value).toMatchObject({ totalCents: null, portal: "airbnb" });
    expect(parseChannexRevision({ ...rev, attributes: { ...rev.attributes, departure_date: "2026-12-01" } }).ok).toBe(false);
    expect(parseChannexRevision({ ...rev, attributes: { ...rev.attributes, status: "pending" } }).ok).toBe(false);
  });
  it("names portals from channel and OTA names", () => {
    expect(["ABB", "AirBNB", "BookingCom", "Booking.com", "VRBO", "HomeAway", "Agoda"].map(portalForChannel)).toEqual(["airbnb", "airbnb", "booking_com", "booking_com", "vrbo", "vrbo", null]);
  });
});

describe("channex webhook check", () => {
  const secret = "s".repeat(40);
  const body = '{"event":"booking"}';
  const sig = (t: number) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  it("accepts a fresh HMAC (either of two during rotation) or the shared header, and nothing else", () => {
    const now = 1_800_000_000;
    expect(verifyChannexWebhook(secret, body, { timestamp: String(now), signature: sig(now), sharedSecret: null }, now)).toBe(true);
    expect(verifyChannexWebhook(secret, body, { timestamp: String(now), signature: `${"0".repeat(64)},${sig(now)}`, sharedSecret: null }, now)).toBe(true);
    expect(verifyChannexWebhook(secret, body, { timestamp: String(now - 400), signature: sig(now - 400), sharedSecret: null }, now)).toBe(false);
    expect(verifyChannexWebhook(secret, `${body} `, { timestamp: String(now), signature: sig(now), sharedSecret: null }, now)).toBe(false);
    expect(verifyChannexWebhook(secret, body, { timestamp: null, signature: null, sharedSecret: secret }, now)).toBe(true);
    expect(verifyChannexWebhook(secret, body, { timestamp: null, signature: null, sharedSecret: "nope" }, now)).toBe(false);
  });
});

describe("channex calls", () => {
  const cfg = channexConfig({ CHANNEX_API_KEY: KEY })!;
  it("sends the key header, masks it in errors and surfaces ARI warnings", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const bad = await channexCall(cfg, async (url, init) => { seen.push({ url, headers: init.headers }); return { status: 422, text: async () => JSON.stringify({ errors: { code: "validation_error", title: `Bad ${KEY}` } }) }; }, "POST", "/properties", {});
    expect(seen[0]).toMatchObject({ url: "https://staging.channex.io/api/v1/properties", headers: { "user-api-key": KEY } });
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain(KEY);
    const warn = await channexCall(cfg, async () => ({ status: 200, text: async () => JSON.stringify({ data: [], meta: { warnings: [{ date: "2020-01-01" }] } }) }), "POST", "/availability", {});
    expect(warn).toMatchObject({ ok: false, status: 200 });
  });

  it("creates only what is missing and saves each id as it goes", async () => {
    const posted: string[] = [];
    const saved: unknown[] = [];
    let n = 0;
    const r = await ensureStructure(cfg, async (url) => { posted.push(url); return { status: 201, text: async () => JSON.stringify({ data: { id: `id-${++n}` } }) }; },
      { propertyId: "P0", roomTypeId: null, ratePlanId: null }, buildChannexContent(listing, {}), async ids => { saved.push({ ...ids }); });
    expect(posted.map(u => u.split("/api/v1")[1])).toEqual(["/room_types", "/rate_plans"]);
    expect(r).toEqual({ ok: true, created: true, ids: { propertyId: "P0", roomTypeId: "id-1", ratePlanId: "id-2" } });
    expect(saved).toHaveLength(2);
  });

  it("builds the channel screen address with a one-time token and the portal codes", async () => {
    const r = await channelScreenUrl(cfg, async () => ({ status: 200, text: async () => JSON.stringify({ data: { token: "tok" } }) }), "P1", "user-1", ["airbnb", "vrbo"]);
    expect(r.ok && new URL(r.url).searchParams.get("channels")).toBe("ABB,VRB");
    expect(r.ok && r.url.startsWith("https://staging.channex.io/auth/exchange?oauth_session_key=tok")).toBe(true);
  });
});
