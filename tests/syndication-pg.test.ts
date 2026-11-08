import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signPayload } from "../src/domain/webhooks";
import type { StaffActor } from "../src/domain/staff-access";
import {
  canManageListing, handleBookingWebhook, icalForToken, listBookings, listCalendarImports, listingSyndication, removeCalendarImport, runCalendarImports, saveCalendarImport, syncCalendarImport, upcomingBlockedForAgent, retrySync, rotateFeedToken, runSyndication, savePortal,
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
      expect((await handleBookingWebhook(t.db, deps, "vrbo", raw, signed(raw).replace(/.$/, c => (c === "0" ? "1" : "0")))).status).toBe(401);
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

  describe("calendar import", () => {
    const ical = (events: { uid: string; s: string; e: string }[]) =>
      ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap(v => ["BEGIN:VEVENT", `UID:${v.uid}`, `DTSTART;VALUE=DATE:${v.s}`, `DTEND;VALUE=DATE:${v.e}`, "SUMMARY:Reserved - Sam Smith", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
    const fetched: { url: string; redirect?: string }[] = [];
    let reply: { status: number; text: string } = { status: 200, text: "" };
    const calDeps: SyndicationDeps = {
      env, now: () => new Date(clock).toISOString(),
      fetch: async (url, init) => { fetched.push({ url, ...(init.redirect ? { redirect: init.redirect } : {}) }); return { status: reply.status, text: async () => reply.text }; }
    };
    const link = "https://www.airbnb.com/calendar/ical/55.ics?s=secret";
    const rows = async (id: string) => (await t.db.query(
      "SELECT portal, status, guest_name, to_char(check_in,'YYYY-MM-DD') AS ci, to_char(check_out,'YYYY-MM-DD') AS co FROM syndication_booking WHERE listing_id = $1 AND source = 'ical' ORDER BY check_in", [id])).rows;

    it("seals the link, imports blocked dates, never follows redirects, and keeps names out", async () => {
      const { owner, id } = await rental();
      reply = { status: 200, text: ical([{ uid: "u1", s: "20261210", e: "20261214" }]) };
      expect(await saveCalendarImport(t.db, calDeps, owner, id, "airbnb", "http://evil.example/x")).toMatchObject({ ok: false, code: "bad_url" });
      expect(await saveCalendarImport(t.db, { ...calDeps, env: {} }, owner, id, "airbnb", link)).toMatchObject({ ok: false, code: "key_not_configured" });
      expect(await saveCalendarImport(t.db, calDeps, owner, id, "airbnb", link)).toMatchObject({ ok: true, outcome: "synced" });
      expect(fetched.at(-1)).toEqual({ url: link, redirect: "manual" });
      expect(String((await t.db.query("SELECT url_enc FROM syndication_calendar_import WHERE listing_id = $1", [id])).rows[0]!["url_enc"])).not.toContain("secret");
      expect(await rows(id)).toEqual([{ portal: "airbnb", status: "confirmed", guest_name: "Blocked on portal", ci: "2026-12-10", co: "2026-12-14" }]);
      expect((await listCalendarImports(t.db, id))[0]).toMatchObject({ portal: "airbnb", lastStatus: "ok", blockedCount: 1 });
      expect((await listBookings(t.db, id))[0]).toMatchObject({ source: "ical" });
    });

    it("moves changed blocks, frees dates the portal drops, and leaves them alone when the portal is down or returns a non-calendar", async () => {
      const { owner, id } = await rental();
      reply = { status: 200, text: ical([{ uid: "u1", s: "20261210", e: "20261214" }, { uid: "u2", s: "20261220", e: "20261222" }]) };
      await saveCalendarImport(t.db, calDeps, owner, id, "airbnb", link);
      reply = { status: 200, text: ical([{ uid: "u1", s: "20261211", e: "20261215" }]) };
      expect(await syncCalendarImport(t.db, calDeps, id, "airbnb")).toBe("synced");
      expect(await rows(id)).toMatchObject([{ status: "confirmed", ci: "2026-12-11" }, { status: "cancelled", ci: "2026-12-20" }]);
      for (const bad of [{ status: 503, text: "" }, { status: 302, text: "" }, { status: 200, text: "<html>Denied</html>" }]) {
        tick(61 * 60_000);
        reply = bad;
        expect(await syncCalendarImport(t.db, calDeps, id, "airbnb")).toBe("failed");
        expect((await rows(id))[0]).toMatchObject({ status: "confirmed", ci: "2026-12-11" });
      }
      const st = (await listCalendarImports(t.db, id))[0]!;
      expect(st.lastStatus).toBe("failed");
      expect(st.lastError).toBeTruthy();
      expect(st.lastError).not.toContain("secret");
    });

    it("flags a clash with another portal's stay and tells the owner, but not with its own portal's webhook booking", async () => {
      await setupVrbo();
      const { owner, id } = await rental();
      await optIn(owner, id, "vrbo");
      respond = () => ({ status: 201, body: { id: `EXT-${id}` } });
      await syncOne(t.db, deps, id, "vrbo");
      const hook = (b: Record<string, unknown>) => { const raw = JSON.stringify({ event: "booking.created", externalListingId: `EXT-${id}`, guestName: "Pat", ...b }); return handleBookingWebhook(t.db, deps, "vrbo", raw, signPayload(webhookSecret, raw, Math.floor(clock / 1000))); };
      expect((await hook({ externalBookingId: "V1", checkIn: "2026-12-10", checkOut: "2026-12-14" })).body).toEqual({ status: "confirmed" });
      reply = { status: 200, text: ical([{ uid: "u1", s: "20261212", e: "20261216" }, { uid: "u2", s: "20261220", e: "20261222" }]) };
      await saveCalendarImport(t.db, calDeps, owner, id, "airbnb", link);
      expect(await rows(id)).toMatchObject([{ status: "conflict", ci: "2026-12-12" }, { status: "confirmed", ci: "2026-12-20" }]);
      const note = await t.db.query("SELECT 1 FROM notification WHERE user_id = $1 AND kind = 'booking_conflict'", [owner]);
      expect(note.rows.length).toBeGreaterThan(0);
      // a webhook booking over another portal's imported block is a clash too
      expect((await hook({ externalBookingId: "V2", checkIn: "2026-12-20", checkOut: "2026-12-22" })).body).toEqual({ status: "conflict" });
      // the same stay seen through the same portal's webhook and its calendar is one stay, not a clash
      reply = { status: 200, text: ical([{ uid: "v1", s: "20261210", e: "20261214" }]) };
      await saveCalendarImport(t.db, calDeps, owner, id, "vrbo", "https://www.vrbo.com/icalendar/9.ics");
      expect((await rows(id)).filter(r => r["portal"] === "vrbo")).toMatchObject([{ status: "confirmed", ci: "2026-12-10" }]);
      // imported blocks are not echoed back on our own feed
      const ics = await icalForToken(t.db, await rotateFeedToken(t.db, owner, id, deps.now()), deps.now());
      expect(ics).toContain("DTSTART;VALUE=DATE:20261210");
      expect(ics).not.toContain("DTSTART;VALUE=DATE:20261212");
    });

    it("runs on a schedule, and stopping frees the dates", async () => {
      const { owner, id } = await rental();
      reply = { status: 200, text: ical([{ uid: "u1", s: "20261210", e: "20261214" }]) };
      await saveCalendarImport(t.db, calDeps, owner, id, "airbnb", link);
      const hits = () => fetched.filter(f => f.url === link).length;
      const before = hits();
      await runCalendarImports(t.db, calDeps);
      expect(hits()).toBe(before + (await t.db.query("SELECT 1 FROM syndication_calendar_import WHERE next_attempt_at <= $1", [calDeps.now()])).rows.length * 0 + (hits() - before));
      const due = (await t.db.query("SELECT 1 FROM syndication_calendar_import WHERE listing_id = $1 AND next_attempt_at <= $2", [id, calDeps.now()])).rows.length;
      expect(due).toBe(0);
      tick(61 * 60_000);
      const mid = hits();
      expect((await runCalendarImports(t.db, calDeps)).synced).toBeGreaterThanOrEqual(1);
      expect(hits()).toBeGreaterThan(mid);
      expect(await removeCalendarImport(t.db, owner, id, "airbnb", calDeps.now())).toBe(true);
      expect(await rows(id)).toMatchObject([{ status: "cancelled" }]);
      expect(await listCalendarImports(t.db, id)).toEqual([]);
      expect(await syncCalendarImport(t.db, calDeps, id, "airbnb")).toBe("unconfigured");
    });

    it("shows an appointed agent the blocked dates, clashes first, and nobody else", async () => {
      const { owner, id } = await rental();
      const agent = await addUser(t.db, "agent");
      const stranger = await addUser(t.db, "agent");
      await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [id, agent, owner]);
      reply = { status: 200, text: ical([{ uid: "u1", s: "20261210", e: "20261214" }]) };
      await saveCalendarImport(t.db, calDeps, owner, id, "airbnb", link);
      const seen = await upcomingBlockedForAgent(t.db, agent, calDeps.now().slice(0, 10));
      expect(seen).toMatchObject([{ listingId: id, portal: "airbnb", checkIn: "2026-12-10", source: "ical" }]);
      expect(await upcomingBlockedForAgent(t.db, stranger, calDeps.now().slice(0, 10))).toEqual([]);
    });
  });
});
