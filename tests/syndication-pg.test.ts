import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signPayload } from "../src/domain/webhooks";
import type { StaffActor } from "../src/domain/staff-access";
import {
  canManageListing, handleBookingWebhook, icalForToken, listBookings, listingSyndication, retrySync, rotateFeedToken, runSyndication, savePortal,
  saveListingSetting, syncOne, type SyndicationDeps
} from "../src/server/syndication-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("listing syndication on Postgres", () => {
  let t: TestDb;
  let clock = Date.parse("2026-11-05T00:00:00Z");
  let staff: StaffActor;
  const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  let respond: (c: { method: string; url: string }) => { status: number; body: unknown } = () => ({ status: 201, body: { id: "X1", url: "https://vrbo.example/p/X1" } });
  const env = { SYNDICATION_SETTINGS_KEY: randomBytes(32).toString("base64"), APP_URL: "https://app.example" };
  const deps: SyndicationDeps = {
    env, now: () => new Date(clock).toISOString(),
    fetch: async (url, init) => {
      calls.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}), ...(init.headers["authorization"] ? { auth: init.headers["authorization"] } : {}) });
      const r = respond({ method: init.method, url });
      return { status: r.status, text: async () => JSON.stringify(r.body) };
    }
  };
  beforeAll(async () => {
    t = await createTestDb();
    staff = { id: await addUser(t.db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });
  const tick = (ms: number) => { clock += ms; };
  let webhookSecret = "";

  async function setupVrbo(opts: { enabled?: boolean } = {}) {
    const a = await savePortal(t.db, staff, "vrbo", { mode: "api", baseUrl: "https://partner.vrbo.example/v1" }, { apiKey: "key-123456", generateWebhookSecret: true }, deps);
    if (!a.ok) throw new Error(a.error);
    webhookSecret = a.newWebhookSecret!;
    if (opts.enabled !== false) {
      const b = await savePortal(t.db, staff, "vrbo", { enabled: true }, {}, deps);
      if (!b.ok) throw new Error(b.error);
    }
  }
  async function rental(status = "published") {
    const owner = await addUser(t.db, "owner");
    const id = await addListing(t.db, owner, { transaction_type: "rent", status, title: "Beach shack", suburb: "Noosa" });
    return { owner, id };
  }
  const optIn = (owner: string, id: string, portal: "vrbo" | "airbnb" = "vrbo", extra: Record<string, unknown> = {}) =>
    saveListingSetting(t.db, owner, id, portal, { enabled: true, custom: { houseRules: "Quiet" }, ...extra }, deps.now());

  it("refuses secrets without a key, never returns them, and needs a complete api portal before switching on", async () => {
    const noKey = await savePortal(t.db, staff, "vrbo", {}, { apiKey: "k-123456" }, { ...deps, env: {} });
    expect(noKey).toMatchObject({ ok: false, code: "key_not_configured" });
    const early = await savePortal(t.db, staff, "booking_com", { enabled: true, mode: "api" }, {}, deps);
    expect(early).toMatchObject({ ok: false, code: "not_ready" });
    await setupVrbo({ enabled: false });
    const row = (await t.db.query("SELECT api_key_enc, webhook_secret_enc FROM syndication_portal WHERE portal = 'vrbo'")).rows[0]!;
    expect(String(row["api_key_enc"])).not.toContain("key-123456");
    expect(String(row["webhook_secret_enc"])).not.toContain(webhookSecret);
    const on = await savePortal(t.db, staff, "vrbo", { enabled: true }, {}, deps);
    expect(on).toMatchObject({ ok: true, portal: { enabled: true, ready: true, hasKey: true } });
    expect(JSON.stringify(on)).not.toContain("key-123456");
    const audit = await t.db.query("SELECT payload FROM audit_event WHERE aggregate_type = 'syndication_portal'");
    expect(JSON.stringify(audit.rows)).not.toContain("key-123456");
  });

  it("only the owner can opt in, and only for a category the portal allows", async () => {
    const { owner, id } = await rental();
    const stranger = await addUser(t.db, "owner");
    expect(await canManageListing(t.db, id, owner)).toBe(true);
    expect(await canManageListing(t.db, id, stranger)).toBe(false);
    const sale = await addListing(t.db, owner, { transaction_type: "sale", status: "published" });
    expect(await optIn(owner, sale)).toBe("not_allowed_category");
    expect(await saveListingSetting(t.db, owner, id, "booking_com", { enabled: true, custom: {} }, deps.now())).toBe("not_available");
    expect(await optIn(owner, id)).toBe("ok");
    const v = await listingSyndication(t.db, id);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ portal: "vrbo", enabled: true, custom: { houseRules: "Quiet" }, state: null });
  });

  it("pushes a published listing, skips an unchanged one, updates a changed one", async () => {
    const { owner, id } = await rental();
    await optIn(owner, id);
    calls.length = 0;
    expect(await syncOne(t.db, deps, id, "vrbo")).toBe("pushed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://partner.vrbo.example/v1/listings", auth: "Bearer key-123456" });
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).toMatchObject({ externalRef: id, title: "Beach shack", houseRules: "Quiet" });
    expect(sent.ownerUserId).toBeUndefined();
    const row = (await t.db.query("SELECT state, external_id, external_url FROM syndication_sync WHERE listing_id = $1", [id])).rows[0]!;
    expect(row).toMatchObject({ state: "live", external_id: "X1", external_url: "https://vrbo.example/p/X1" });

    expect(await syncOne(t.db, deps, id, "vrbo")).toBe("unchanged");
    expect(calls).toHaveLength(1);

    await t.db.query("UPDATE property_listing SET title = 'Beach house' WHERE id = $1", [id]);
    respond = () => ({ status: 200, body: {} });
    expect(await syncOne(t.db, deps, id, "vrbo")).toBe("pushed");
    expect(calls[1]).toMatchObject({ method: "PUT", url: "https://partner.vrbo.example/v1/listings/X1" });
    respond = () => ({ status: 201, body: { id: "X2" } });
  });

  it("never pushes a draft, and de-lists when the listing stops being published", async () => {
    const draft = await rental("draft");
    await t.db.query("UPDATE property_listing SET status = 'draft' WHERE id = $1", [draft.id]);
    await optIn(draft.owner, draft.id);
    calls.length = 0;
    expect(await syncOne(t.db, deps, draft.id, "vrbo")).toBe("skipped");
    expect(calls).toHaveLength(0);

    const { owner, id } = await rental();
    await optIn(owner, id);
    respond = () => ({ status: 201, body: { id: "DEL1" } });
    await syncOne(t.db, deps, id, "vrbo");
    calls.length = 0;
    await t.db.query("UPDATE property_listing SET status = 'withdrawn' WHERE id = $1", [id]);
    const counts = await runSyndication(t.db, deps);
    expect(counts.removed).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => c.url.endsWith("/DEL1"))).toEqual([expect.objectContaining({ method: "DELETE", url: "https://partner.vrbo.example/v1/listings/DEL1" })]);
    expect((await t.db.query("SELECT state, external_id FROM syndication_sync WHERE listing_id = $1", [id])).rows[0]).toMatchObject({ state: "removed", external_id: null });
    calls.length = 0;
    await runSyndication(t.db, deps);
    expect(calls.filter(c => c.url.endsWith("/DEL1"))).toHaveLength(0);
  });

  it("de-lists when the owner turns the toggle off", async () => {
    const { owner, id } = await rental();
    await optIn(owner, id);
    respond = () => ({ status: 201, body: { id: "OFF1" } });
    await syncOne(t.db, deps, id, "vrbo");
    await saveListingSetting(t.db, owner, id, "vrbo", { enabled: false, custom: {} }, deps.now());
    calls.length = 0;
    expect(await syncOne(t.db, deps, id, "vrbo")).toBe("removed");
    expect(calls[0]).toMatchObject({ method: "DELETE" });
  });

  it("records failures, backs off, hides secrets, and retries on request", async () => {
    const { owner, id } = await rental();
    await optIn(owner, id);
    respond = () => ({ status: 500, body: { message: "boom key-123456" } });
    expect(await syncOne(t.db, deps, id, "vrbo")).toBe("failed");
    let row = (await t.db.query("SELECT state, attempts, last_error, next_attempt_at FROM syndication_sync WHERE listing_id = $1", [id])).rows[0]!;
    expect(row).toMatchObject({ state: "failed", attempts: 1 });
    expect(String(row["last_error"])).toContain("500");
    expect(String(row["last_error"])).not.toContain("key-123456");
    expect(Date.parse(new Date(row["next_attempt_at"] as string).toISOString())).toBe(clock + 60_000);

    calls.length = 0;
    await runSyndication(t.db, deps);
    expect(calls.filter(c => c.body?.includes(id))).toHaveLength(0);
    tick(61_000);
    respond = () => ({ status: 201, body: { id: "RETRY1" } });
    await runSyndication(t.db, deps);
    row = (await t.db.query("SELECT state, attempts FROM syndication_sync WHERE listing_id = $1", [id])).rows[0]!;
    expect(row).toMatchObject({ state: "live", attempts: 0 });

    const bad = await rental();
    await optIn(bad.owner, bad.id);
    respond = () => ({ status: 503, body: {} });
    for (let i = 0; i < 6; i++) { await syncOne(t.db, deps, bad.id, "vrbo"); tick(7 * 3_600_000); }
    row = (await t.db.query("SELECT state, attempts, next_attempt_at FROM syndication_sync WHERE listing_id = $1", [bad.id])).rows[0]!;
    expect(row).toMatchObject({ state: "failed", attempts: 6, next_attempt_at: null });
    calls.length = 0;
    await runSyndication(t.db, deps);
    expect(calls.filter(c => c.body?.includes(bad.id))).toHaveLength(0);
    respond = () => ({ status: 201, body: { id: "BAD1" } });
    expect(await retrySync(t.db, staff, bad.id, "vrbo", deps.now())).toBe(true);
    expect(await syncOne(t.db, deps, bad.id, "vrbo")).toBe("pushed");
    expect(await retrySync(t.db, staff, bad.id, "vrbo", deps.now())).toBe(false);
  });

  it("respects the per-portal rate limit", async () => {
    await savePortal(t.db, staff, "vrbo", { maxPerMinute: 1 }, {}, deps);
    const a = await rental(); const b = await rental();
    await optIn(a.owner, a.id); await optIn(b.owner, b.id);
    tick(3_600_000);
    respond = () => ({ status: 201, body: { id: `R${calls.length}` } });
    const first = await syncOne(t.db, deps, a.id, "vrbo");
    const second = await syncOne(t.db, deps, b.id, "vrbo");
    expect([first, second]).toEqual(["pushed", "rate_limited"]);
    tick(61_000);
    respond = () => ({ status: 201, body: { id: "R-B" } });
    expect(await syncOne(t.db, deps, b.id, "vrbo")).toBe("pushed");
    await savePortal(t.db, staff, "vrbo", { maxPerMinute: 30 }, {}, deps);
  });

  describe("bookings", () => {
    const body = (o: Record<string, unknown>) => JSON.stringify({ event: "booking.created", externalListingId: "BK1", externalBookingId: "B1", guestName: "Sam Guest", guests: 2, checkIn: "2026-12-01", checkOut: "2026-12-04", totalCents: 90_000, ...o });
    const signed = (raw: string, secret = webhookSecret, at = Math.floor(clock / 1000)) => signPayload(secret, raw, at);
    let listingId = "";
    let owner = "";

    it("rejects missing, wrong and stale signatures and unknown listings", async () => {
      ({ owner, id: listingId } = await rental());
      await optIn(owner, listingId);
      respond = () => ({ status: 201, body: { id: "BK1" } });
      await syncOne(t.db, deps, listingId, "vrbo");
      const raw = body({});
      expect((await handleBookingWebhook(t.db, deps, "vrbo", raw, null)).status).toBe(401);
      expect((await handleBookingWebhook(t.db, deps, "vrbo", raw, signed(raw, "whsec_wrong"))).status).toBe(401);
      expect((await handleBookingWebhook(t.db, deps, "vrbo", raw, signed(raw, webhookSecret, Math.floor(clock / 1000) - 3600))).status).toBe(401);
      expect((await handleBookingWebhook(t.db, deps, "vrbo", raw, signed(raw).replace(/.$/, "0"))).status).toBe(401);
      const other = body({ externalListingId: "NOPE" });
      expect((await handleBookingWebhook(t.db, deps, "vrbo", other, signed(other))).status).toBe(404);
      expect((await handleBookingWebhook(t.db, deps, "airbnb", raw, signed(raw))).status).toBe(404);
      expect(await listBookings(t.db, listingId)).toHaveLength(0);
    });

    it("books once (idempotent), blocks overlapping stays, allows same-day turnover, and cancels", async () => {
      const raw = body({});
      expect(await handleBookingWebhook(t.db, deps, "vrbo", raw, signed(raw))).toEqual({ status: 200, body: { status: "confirmed" } });
      expect(await handleBookingWebhook(t.db, deps, "vrbo", raw, signed(raw))).toEqual({ status: 200, body: { status: "duplicate" } });
      const clash = body({ externalBookingId: "B2", checkIn: "2026-12-03", checkOut: "2026-12-06" });
      expect((await handleBookingWebhook(t.db, deps, "vrbo", clash, signed(clash))).body).toEqual({ status: "conflict" });
      const turnover = body({ externalBookingId: "B3", checkIn: "2026-12-04", checkOut: "2026-12-06" });
      expect((await handleBookingWebhook(t.db, deps, "vrbo", turnover, signed(turnover))).body).toEqual({ status: "confirmed" });
      const rows = await listBookings(t.db, listingId);
      expect(rows.map(r => [r.checkIn, r.status]).sort()).toEqual([["2026-12-01", "confirmed"], ["2026-12-03", "conflict"], ["2026-12-04", "confirmed"]]);
      const notes = await t.db.query("SELECT kind FROM notification WHERE user_id = $1", [owner]);
      expect(notes.rows.map(r => r["kind"]).sort()).toEqual(["booking_conflict", "booking_received", "booking_received"]);

      const cancel = body({ event: "booking.cancelled" });
      expect((await handleBookingWebhook(t.db, deps, "vrbo", cancel, signed(cancel))).body).toEqual({ status: "cancelled" });
      const again = body({ externalBookingId: "B4", checkIn: "2026-12-02", checkOut: "2026-12-03" });
      expect((await handleBookingWebhook(t.db, deps, "vrbo", again, signed(again))).body).toEqual({ status: "confirmed" });
    });

    it("serves booked dates (no guest details) on an iCal feed that only the latest token opens", async () => {
      const first = await rotateFeedToken(t.db, owner, listingId, deps.now());
      const ics = await icalForToken(t.db, first, deps.now());
      expect(ics).toContain("DTSTART;VALUE=DATE:20261202");
      expect(ics).toContain("DTSTART;VALUE=DATE:20261204");
      expect(ics).not.toContain("DTSTART;VALUE=DATE:20261201");
      expect(ics).not.toContain("DTSTART;VALUE=DATE:20261203");
      expect(ics).not.toMatch(/Sam/);
      const second = await rotateFeedToken(t.db, owner, listingId, deps.now());
      expect(await icalForToken(t.db, first, deps.now())).toBeNull();
      expect(await icalForToken(t.db, second, deps.now())).not.toBeNull();
      expect(await icalForToken(t.db, "x".repeat(43), deps.now())).toBeNull();
      expect(await icalForToken(t.db, "short", deps.now())).toBeNull();
      expect((await t.db.query("SELECT token_hash FROM syndication_feed WHERE listing_id = $1", [listingId])).rows[0]!["token_hash"]).not.toBe(second);
    });
  });

  it("tracks the owner's link on a manual portal and flags removal when unpublished", async () => {
    await savePortal(t.db, staff, "airbnb", { enabled: true }, {}, deps);
    const { owner, id } = await rental();
    expect(await optIn(owner, id, "airbnb", { manualUrl: "https://airbnb.example/rooms/9" })).toBe("ok");
    calls.length = 0;
    expect(await syncOne(t.db, deps, id, "airbnb")).toBe("manual");
    expect(calls).toHaveLength(0);
    expect((await t.db.query("SELECT state, external_url FROM syndication_sync WHERE listing_id = $1 AND portal = 'airbnb'", [id])).rows[0]).toMatchObject({ state: "manual", external_url: "https://airbnb.example/rooms/9" });
    await t.db.query("UPDATE property_listing SET status = 'suspended' WHERE id = $1", [id]);
    await runSyndication(t.db, deps);
    expect((await t.db.query("SELECT state FROM syndication_sync WHERE listing_id = $1 AND portal = 'airbnb'", [id])).rows[0]!["state"]).toBe("manual_removal");
    expect(calls.filter(c => c.body?.includes(id) || c.url.endsWith(id))).toHaveLength(0);
  });
});
