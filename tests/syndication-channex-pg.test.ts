import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import {
  channexConnectUrl, handleChannexWebhook, listBookings, listingSyndication, runChannexBookings, runSyndication, savePortal, saveListingSetting, syncOne, type SyndicationDeps
} from "../src/server/syndication-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("listing syndication through Channex on Postgres", () => {
  let t: TestDb;
  let staff: StaffActor;
  let clock = Date.parse("2026-11-05T00:00:00Z");
  const secret = "w".repeat(40);
  const env = { SYNDICATION_SETTINGS_KEY: randomBytes(32).toString("base64"), APP_URL: "https://app.example", CHANNEX_API_KEY: "chx-key-0123456789abcdef", CHANNEX_WEBHOOK_SECRET: secret };
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let ids = 0;
  let channels: { id: string; attributes: Record<string, unknown> }[] = [];
  let feed: unknown[] = [];
  const revisions = new Map<string, unknown>();
  const deps: SyndicationDeps = {
    env, now: () => new Date(clock).toISOString(),
    fetch: async (url, init) => {
      const path = url.replace("https://staging.channex.io/api/v1", "");
      calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : {} });
      const ok = (data: unknown, status = 200) => ({ status, text: async () => JSON.stringify({ data }) });
      if (init.method === "POST" && /^\/(properties|room_types|rate_plans)$/.test(path)) return ok({ id: `cx-${++ids}`, type: "x", attributes: {} }, 201);
      if (init.method === "GET" && path.startsWith("/channels")) return ok(channels);
      if (init.method === "POST" && /^\/channels\/[^/]+\/(activate|deactivate)$/.test(path)) {
        const [, , id, what] = path.split("/");
        const c = channels.find(x => x.id === id);
        if (c) c.attributes["is_active"] = what === "activate";
        return ok({});
      }
      if (init.method === "GET" && path.startsWith("/booking_revisions/feed")) return ok(feed);
      if (init.method === "GET" && path.startsWith("/booking_revisions/")) return ok(revisions.get(path.split("/")[2]!) ?? null);
      if (init.method === "POST" && path === "/auth/one_time_token") return ok({ token: "once" });
      return ok({});
    }
  };
  const tick = (ms: number) => { clock += ms; };
  const reset = () => { calls.length = 0; };
  const rev = (id: string, propertyId: string, status: string, a: string, d: string, ota = "Airbnb") =>
    ({ id, type: "booking_revision", attributes: { property_id: propertyId, booking_id: "BK-1", ota_name: ota, status, arrival_date: a, departure_date: d, customer: { name: "Ann", surname: "Lee" }, occupancy: { adults: 2 }, amount: "300.00", currency: "AUD" } });

  beforeAll(async () => {
    t = await createTestDb();
    staff = { id: await addUser(t.db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("will not switch a portal to Channex without the account key", async () => {
    const r = await savePortal(t.db, staff, "airbnb", { mode: "channex", enabled: true }, {}, { ...deps, env: { SYNDICATION_SETTINGS_KEY: env.SYNDICATION_SETTINGS_KEY } });
    expect(r).toMatchObject({ ok: false, code: "not_ready" });
  });

  it("creates one Channex property for a listing shared on two portals, then sends nothing when nothing changed", async () => {
    for (const p of ["airbnb", "booking_com"] as const) expect((await savePortal(t.db, staff, p, { mode: "channex", enabled: true }, {}, deps)).ok).toBe(true);
    const owner = await addUser(t.db, "owner");
    const id = await addListing(t.db, owner, { transaction_type: "rent", status: "published", title: "Beach shack", suburb: "Noosa", jurisdiction: "QLD", price_cents: 70_000, bedrooms: 2 });
    expect(await saveListingSetting(t.db, owner, id, "airbnb", { enabled: true, custom: {} }, deps.now())).toBe("needs_upgrade");
    expect((await listingSyndication(t.db, id)).find(v => v.portal === "airbnb")?.needsUpgrade).toBe(true);
    await t.db.query("INSERT INTO invoice (owner_user_id, listing_id, plan_id, kind, amount_ex_gst_cents, gst_cents, total_cents, status, provider, paid_at) VALUES ($1, $2, 'premium', 'listing_fee', 1000, 100, 1100, 'paid', 'payway', now())", [owner, id]);
    await saveListingSetting(t.db, owner, id, "airbnb", { enabled: true, custom: { minNights: 2, nightlyRateCents: 15_000 } }, deps.now());
    await saveListingSetting(t.db, owner, id, "booking_com", { enabled: true, custom: {} }, deps.now());
    await t.db.query("INSERT INTO syndication_booking (listing_id, portal, external_booking_id, guest_name, check_in, check_out, status) VALUES ($1, 'vrbo', 'X', 'G', '2026-11-10', '2026-11-12', 'confirmed')", [id]);
    reset();
    const counts = await runSyndication(t.db, deps);
    expect(counts.pushed).toBe(2);
    expect(calls.filter(c => c.method === "POST" && c.path === "/properties")).toHaveLength(1);
    expect(calls.filter(c => c.path === "/room_types" || c.path === "/rate_plans")).toHaveLength(2);
    const prop = calls.find(c => c.path === "/properties")!.body["property"] as Record<string, unknown>;
    expect(prop).toMatchObject({ currency: "AUD", country: "AU", timezone: "Australia/Brisbane" });
    const avail = calls.find(c => c.path === "/availability")!.body["values"] as Record<string, unknown>[];
    expect(avail.find(v => v["availability"] === 0)).toMatchObject({ date_from: "2026-11-10", date_to: "2026-11-11" });
    const rates = calls.find(c => c.path === "/restrictions")!.body["values"] as Record<string, unknown>[];
    expect(rates[0]).toMatchObject({ rate: 15_000, min_stay_arrival: 2, rate_plan_id: "cx-3" });
    expect(calls.filter(c => c.path === "/availability")).toHaveLength(1);
    const syncs = await t.db.query("SELECT portal, state, external_id FROM syndication_sync WHERE listing_id = $1 ORDER BY portal", [id]);
    expect(syncs.rows).toEqual([{ portal: "airbnb", state: "live", external_id: "cx-1" }, { portal: "booking_com", state: "live", external_id: "cx-1" }]);

    // the owner connects Airbnb in Channex
    channels = [{ id: "ch-1", attributes: { channel: "AirBNB", is_active: true, properties: ["cx-1"] } }];
    expect(await channexConnectUrl(t.db, deps, owner, id)).toMatchObject({ ok: true });
    expect(calls.at(-1)).toMatchObject({ path: "/auth/one_time_token", body: { one_time_token: { property_id: "cx-1", username: owner } } });
    reset();
    expect(await syncOne(t.db, deps, id, "airbnb")).toBe("pushed");
    expect(calls.map(c => c.path)).toEqual(["/channels?filter[property_id]=cx-1&pagination[limit]=100"]);
    reset();
    expect(await syncOne(t.db, deps, id, "airbnb")).toBe("unchanged");
    expect(calls).toHaveLength(0);
    const view = await listingSyndication(t.db, id);
    expect(view.map(v => [v.portal, v.connected])).toEqual([["airbnb", true], ["booking_com", false]]);
  });

  it("stores Channex bookings once, acknowledges them, follows changes and cancellations, and ignores other sites", async () => {
    const lid = String((await t.db.query("SELECT listing_id FROM channex_property WHERE property_id = 'cx-1'")).rows[0]!["listing_id"]);
    feed = [rev("r1", "cx-1", "new", "2026-12-01", "2026-12-04"), rev("r0", "cx-1", "new", "2026-12-20", "2026-12-21", "Agoda")];
    reset();
    expect(await runChannexBookings(t.db, deps)).toEqual({ stored: 1, ignored: 1, failed: 0 });
    expect(calls.filter(c => c.path.endsWith("/ack")).map(c => c.path)).toEqual(["/booking_revisions/r1/ack", "/booking_revisions/r0/ack"]);
    let b = await listBookings(t.db, lid);
    expect(b.find(x => x.portal === "airbnb")).toMatchObject({ guestName: "Ann Lee", checkIn: "2026-12-01", checkOut: "2026-12-04", totalCents: 30_000, status: "confirmed" });

    // a webhook with a bad signature is refused before anything is read
    const body = JSON.stringify({ event: "booking", payload: { revision_id: "r2", property_id: "cx-1", booking_id: "BK-1" } });
    const ts = Math.floor(clock / 1000);
    expect((await handleChannexWebhook(t.db, deps, body, { timestamp: String(ts), signature: "0".repeat(64), sharedSecret: null })).status).toBe(401);
    revisions.set("r2", rev("r2", "cx-1", "modified", "2026-12-02", "2026-12-05"));
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(await handleChannexWebhook(t.db, deps, body, { timestamp: String(ts), signature: sig, sharedSecret: null })).toEqual({ status: 200, body: { status: "changed" } });
    b = await listBookings(t.db, lid);
    expect(b.filter(x => x.portal === "airbnb")).toHaveLength(1);
    expect(b.find(x => x.portal === "airbnb")).toMatchObject({ checkIn: "2026-12-02", checkOut: "2026-12-05" });

    // the change re-sends the calendar on the next run
    reset();
    await runSyndication(t.db, deps);
    const avail = calls.find(c => c.path === "/availability")!.body["values"] as Record<string, unknown>[];
    expect(avail).toContainEqual(expect.objectContaining({ date_from: "2026-12-02", date_to: "2026-12-04", availability: 0 }));

    feed = [rev("r3", "cx-1", "cancelled", "2026-12-02", "2026-12-05")];
    expect(await runChannexBookings(t.db, deps)).toEqual({ stored: 1, ignored: 0, failed: 0 });
    expect((await listBookings(t.db, lid)).find(x => x.portal === "airbnb")?.status).toBe("cancelled");
  });

  it("switches off the portal's channel when the owner turns it off, and closes every night when no portal wants the listing", async () => {
    const lid = String((await t.db.query("SELECT listing_id FROM channex_property WHERE property_id = 'cx-1'")).rows[0]!["listing_id"]);
    const owner = String((await t.db.query("SELECT owner_user_id FROM property_listing WHERE id = $1", [lid])).rows[0]!["owner_user_id"]);
    tick(60_000);
    reset();
    await saveListingSetting(t.db, owner, lid, "airbnb", { enabled: false, custom: {} }, deps.now());
    expect(await syncOne(t.db, deps, lid, "airbnb")).toBe("removed");
    expect(calls.map(c => `${c.method} ${c.path.split("?")[0]}`)).toEqual(["GET /channels", "POST /channels/ch-1/deactivate"]);
    reset();
    await saveListingSetting(t.db, owner, lid, "booking_com", { enabled: false, custom: {} }, deps.now());
    expect(await syncOne(t.db, deps, lid, "booking_com")).toBe("removed");
    const closed = calls.find(c => c.path === "/availability")!.body["values"] as Record<string, unknown>[];
    expect(closed).toEqual([expect.objectContaining({ availability: 0, date_from: "2026-11-05" })]);
    expect((await t.db.query("SELECT ari_closed FROM channex_property WHERE listing_id = $1", [lid])).rows[0]!["ari_closed"]).toBe(true);

    // turning Airbnb back on re-opens the calendar and switches its channel back on
    reset();
    await saveListingSetting(t.db, owner, lid, "airbnb", { enabled: true, custom: { nightlyRateCents: 15_000 } }, deps.now());
    expect(await syncOne(t.db, deps, lid, "airbnb")).toBe("pushed");
    expect(calls.some(c => c.path === "/availability")).toBe(true);
    expect(calls.some(c => c.path === "/channels/ch-1/activate")).toBe(true);
    expect(calls.some(c => c.path === "/properties")).toBe(false);
  });

  it("takes the listing off the portals when its paid package no longer counts", async () => {
    const lid = String((await t.db.query("SELECT listing_id FROM channex_property WHERE property_id = 'cx-1'")).rows[0]!["listing_id"]);
    await t.db.query("UPDATE invoice SET status = 'refunded' WHERE listing_id = $1", [lid]);
    reset();
    const counts = await runSyndication(t.db, deps);
    expect(counts.removed).toBe(1);
    expect(calls.some(c => c.path === "/channels/ch-1/deactivate")).toBe(true);
    expect(calls.find(c => c.path === "/availability")?.body["values"]).toEqual([expect.objectContaining({ availability: 0 })]);
    expect((await t.db.query("SELECT state FROM syndication_sync WHERE listing_id = $1 AND portal = 'airbnb'", [lid])).rows[0]!["state"]).toBe("removed");
  });
});
