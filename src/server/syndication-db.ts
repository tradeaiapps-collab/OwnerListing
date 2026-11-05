import { createHash, randomBytes, randomUUID } from "node:crypto";
import { messagingKeyUsable, openSetting, sealSetting } from "../domain/messaging-crypto";
import { photoUrl } from "../domain/listing-photos";
import {
  buildIcal, buildPortalPayload, IMPORT_EVERY_MINUTES, ineligibleReason, MAX_ATTEMPTS, MAX_ICAL_BYTES, nextAttemptAt, nextRetryDelaySeconds, nights, parseIcal, parseIncomingBooking, payloadHash, PORTAL_LABELS, PORTALS,
  portalReady, safeError, STALE_AFTER_HOURS, validateCalendarUrl, type IncomingBooking, type ListingPortalInput, type Portal, type PortalConfigInput, type PortalCustomFields,
  type PortalMode, type PortalPayload, type SyncState, type SyndicationListing
} from "../domain/syndication";
import { newWebhookSecret, verifySignature } from "../domain/webhooks";
import type { StaffActor } from "../domain/staff-access";
import { appendAuditPg, type Queryable } from "./db";
import { notifyUser } from "./notifier";
import {
  ackRevision, buildAri, buildChannexContent, channelScreenUrl, channexConfig, ensureStructure, getRevision, listChannels, parseChannexRevision, pushAri, revisionFeed,
  setChannelActive, updateContent, verifyChannexWebhook, type ChannexConfig, type ChannexRevision
} from "../adapters/portals/channex";

type Env = Readonly<Record<string, string | undefined>>;
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "manual" }) => Promise<{ status: number; text(): Promise<string> }>;
export interface SyndicationDeps { env: Env; fetch: Fetch; now: () => string }
export const syndicationDeps = (): SyndicationDeps => ({ env: process.env, fetch: (u, i) => fetch(u, i), now: () => new Date().toISOString() });

const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const day = (v: unknown): string => String(v).slice(0, 10);
const FETCH_TIMEOUT_MS = 10_000;
const BATCH = 25;

const audit = (db: Queryable, actorType: "user" | "system", actorId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>, now: string) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType, actorId, aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload });

// ---- Portal setup ---------------------------------------------------------------------------------------------------------------

export interface PortalRow {
  portal: Portal; enabled: boolean; mode: PortalMode; baseUrl: string | null; hasKey: boolean; hasWebhookSecret: boolean;
  allowedTransactionTypes: string[]; maxPerMinute: number; updatedAt: string | null; ready: boolean;
}
interface PortalSecrets { apiKey: string | null; webhookSecret: string | null }
const keyField = (p: Portal, kind: "apiKey" | "webhookSecret") => `syndication.${p}.${kind}`;

const toPortal = (r: Record<string, unknown>): PortalRow => {
  const base = {
    portal: r["portal"] as Portal, enabled: r["enabled"] === true, mode: (r["mode"] === "api" || r["mode"] === "channex" ? r["mode"] : "manual") as PortalMode,
    baseUrl: typeof r["base_url"] === "string" ? r["base_url"] : null, hasKey: typeof r["api_key_enc"] === "string",
    hasWebhookSecret: typeof r["webhook_secret_enc"] === "string", allowedTransactionTypes: r["allowed_transaction_types"] as string[],
    maxPerMinute: Number(r["max_per_minute"]), updatedAt: iso(r["updated_at"])
  };
  return { ...base, ready: portalReady(base) };
};
const PORTAL_COLS = "portal, enabled, mode, base_url, api_key_enc, webhook_secret_enc, allowed_transaction_types, max_per_minute, updated_at";

export async function listPortals(db: Queryable): Promise<PortalRow[]> {
  const r = await db.query(`SELECT ${PORTAL_COLS} FROM syndication_portal ORDER BY portal`);
  return r.rows.map(toPortal);
}

async function loadPortal(db: Queryable, portal: Portal, env: Env): Promise<{ row: PortalRow; secrets: PortalSecrets } | null> {
  const r = await db.query(`SELECT ${PORTAL_COLS} FROM syndication_portal WHERE portal = $1`, [portal]);
  const rec = r.rows[0];
  if (!rec) return null;
  const key = env["SYNDICATION_SETTINGS_KEY"];
  const open = async (enc: unknown, kind: "apiKey" | "webhookSecret") =>
    typeof enc === "string" && messagingKeyUsable(key) ? (await openSetting(enc, key, keyField(portal, kind)).catch(() => undefined)) ?? null : null;
  return { row: toPortal(rec), secrets: { apiKey: await open(rec["api_key_enc"], "apiKey"), webhookSecret: await open(rec["webhook_secret_enc"], "webhookSecret") } };
}

export type SavePortalResult = { ok: true; portal: PortalRow; newWebhookSecret?: string } | { ok: false; error: string; code: string };

/**
 * Staff change to a portal. Secrets are sealed under SYNDICATION_SETTINGS_KEY (refused, nothing saved, while it is unusable) and never returned;
 * a new webhook secret is shown once, in this result. Switching an api-mode portal on needs address, key and webhook secret. Audited by field name only.
 */
export async function savePortal(
  db: Queryable, staff: StaffActor, portal: Portal, input: PortalConfigInput, secrets: { apiKey?: string | null; generateWebhookSecret?: boolean }, deps: SyndicationDeps
): Promise<SavePortalResult> {
  const cur = await loadPortal(db, portal, deps.env);
  if (!cur) return { ok: false, error: "Unknown portal.", code: "not_found" };
  const touchesSecret = secrets.apiKey !== undefined || secrets.generateWebhookSecret === true;
  const key = deps.env["SYNDICATION_SETTINGS_KEY"];
  if (touchesSecret && !messagingKeyUsable(key)) return { ok: false, error: "Encryption key not configured. Nothing was saved.", code: "key_not_configured" };
  const apiKeyEnc = secrets.apiKey === undefined ? undefined : secrets.apiKey === null || secrets.apiKey === "" ? null : await sealSetting(secrets.apiKey, key, keyField(portal, "apiKey"));
  const whSecret = secrets.generateWebhookSecret ? newWebhookSecret() : undefined;
  const whEnc = whSecret ? await sealSetting(whSecret, key, keyField(portal, "webhookSecret")) : undefined;

  const next = {
    enabled: input.enabled ?? cur.row.enabled, mode: input.mode ?? cur.row.mode, baseUrl: input.baseUrl === undefined ? cur.row.baseUrl : input.baseUrl,
    hasKey: apiKeyEnc === undefined ? cur.row.hasKey : apiKeyEnc !== null, hasWebhookSecret: whEnc !== undefined || cur.row.hasWebhookSecret
  };
  if (next.enabled && next.mode === "channex" && !channexConfig(deps.env)) {
    return { ok: false, error: "Channex is not set up yet: set CHANNEX_API_KEY (and CHANNEX_WEBHOOK_SECRET) first.", code: "not_ready" };
  }
  if (next.enabled && !portalReady(next)) {
    return { ok: false, error: next.mode === "api" ? "To switch an API portal on, set its address, API key and webhook secret first." : "Portal is not ready.", code: "not_ready" };
  }
  const now = deps.now();
  await inTx(db, async tx => {
    await tx.query(
      `UPDATE syndication_portal SET enabled = $2, mode = $3, base_url = $4,
              api_key_enc = CASE WHEN $5::boolean THEN $6 ELSE api_key_enc END,
              webhook_secret_enc = CASE WHEN $7::boolean THEN $8 ELSE webhook_secret_enc END,
              allowed_transaction_types = COALESCE($9::text[], allowed_transaction_types), max_per_minute = COALESCE($10::int, max_per_minute),
              updated_by = $1::uuid, updated_at = $11::timestamptz WHERE portal = $12`,
      [staff.id, next.enabled, next.mode, next.baseUrl, apiKeyEnc !== undefined, apiKeyEnc ?? null, whEnc !== undefined, whEnc ?? null,
       input.allowedTransactionTypes ?? null, input.maxPerMinute ?? null, now, portal]);
    await audit(tx, "user", staff.id, "syndication_portal", portal, "syndication.portal_updated",
      { role: staff.role, fields: [...Object.keys(input), ...(apiKeyEnc !== undefined ? ["apiKey"] : []), ...(whEnc !== undefined ? ["webhookSecret"] : [])] }, now);
  });
  const row = (await loadPortal(db, portal, deps.env))!.row;
  return { ok: true, portal: row, ...(whSecret ? { newWebhookSecret: whSecret } : {}) };
}

// ---- Per-listing settings -------------------------------------------------------------------------------------------------------

/** The listing's owner, or its appointed agent with full scope. */
export async function canManageListing(db: Queryable, listingId: string, userId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM property_listing l WHERE l.id = $1::uuid AND (l.owner_user_id = $2::uuid OR EXISTS (
       SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $2::uuid AND a.revoked_at IS NULL AND a.scope = 'full'))`,
    [listingId, userId]);
  return r.rows.length > 0;
}

export interface ListingPortalView {
  portal: Portal; label: string; mode: PortalMode; available: boolean; eligibleReason: string | null; enabled: boolean; custom: PortalCustomFields;
  manualUrl: string | null; state: SyncState | null; externalUrl: string | null; lastError: string | null; lastSyncedAt: string | null;
  /** Channex mode only: whether the owner's own account for this portal is connected (null in other modes). */
  connected: boolean | null;
}

/** What the owner sees: one row per portal staff have switched on and ready, with this listing's choice and sync state. */
export async function listingSyndication(db: Queryable, listingId: string): Promise<ListingPortalView[]> {
  const l = await db.query("SELECT status, transaction_type FROM property_listing WHERE id = $1::uuid", [listingId]);
  const listing = l.rows[0];
  if (!listing) return [];
  const portals = await listPortals(db);
  const settings = await db.query("SELECT portal, enabled, custom, manual_url FROM syndication_listing_setting WHERE listing_id = $1::uuid", [listingId]);
  const syncs = await db.query("SELECT portal, state, external_url, last_error, last_synced_at FROM syndication_sync WHERE listing_id = $1::uuid", [listingId]);
  const cx = await db.query("SELECT connected_portals FROM channex_property WHERE listing_id = $1::uuid", [listingId]);
  const connected = new Set((cx.rows[0]?.["connected_portals"] as string[] | undefined) ?? []);
  return portals.filter(p => p.ready).map(p => {
    const s = settings.rows.find(x => x["portal"] === p.portal);
    const y = syncs.rows.find(x => x["portal"] === p.portal);
    return {
      portal: p.portal, label: PORTAL_LABELS[p.portal], mode: p.mode, available: true,
      eligibleReason: ineligibleReason({ status: String(listing["status"]), transactionType: String(listing["transaction_type"]) }, p.allowedTransactionTypes),
      enabled: s?.["enabled"] === true, custom: (s?.["custom"] as PortalCustomFields | undefined) ?? {}, manualUrl: typeof s?.["manual_url"] === "string" ? s["manual_url"] : null,
      state: y ? (y["state"] as SyncState) : null, externalUrl: typeof y?.["external_url"] === "string" ? y["external_url"] : null,
      lastError: typeof y?.["last_error"] === "string" ? y["last_error"] : null, lastSyncedAt: iso(y?.["last_synced_at"]),
      connected: p.mode === "channex" ? connected.has(p.portal) : null
    };
  });
}

export async function saveListingSetting(db: Queryable, userId: string, listingId: string, portal: Portal, input: ListingPortalInput, now: string): Promise<"ok" | "not_available" | "not_allowed_category"> {
  const p = (await listPortals(db)).find(x => x.portal === portal);
  if (!p || !p.ready) return "not_available";
  if (input.enabled) {
    const l = await db.query("SELECT transaction_type FROM property_listing WHERE id = $1::uuid", [listingId]);
    if (!p.allowedTransactionTypes.includes(String(l.rows[0]?.["transaction_type"]))) return "not_allowed_category";
  }
  await inTx(db, async tx => {
    await tx.query(
      `INSERT INTO syndication_listing_setting (listing_id, portal, enabled, custom, manual_url, updated_by, updated_at)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::uuid, $7::timestamptz)
       ON CONFLICT (listing_id, portal) DO UPDATE SET enabled = EXCLUDED.enabled, custom = EXCLUDED.custom,
         manual_url = CASE WHEN $8::boolean THEN EXCLUDED.manual_url ELSE syndication_listing_setting.manual_url END,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [listingId, portal, input.enabled, JSON.stringify(input.custom), input.manualUrl ?? null, userId, now, input.manualUrl !== undefined]);
    await audit(tx, "user", userId, "listing", listingId, "syndication.setting_changed", { portal, enabled: input.enabled }, now);
  });
  return "ok";
}

// ---- Sync worker ------------------------------------------------------------------------------------------------------------------

async function loadSyndicationListing(db: Queryable, listingId: string, env: Env): Promise<(SyndicationListing & { status: string; transactionType: string }) | null> {
  const r = await db.query(
    `SELECT id, title, description, property_type, transaction_type, address_text, suburb, jurisdiction, status, bedrooms, price_cents, updated_at
       FROM property_listing WHERE id = $1::uuid`, [listingId]);
  const l = r.rows[0];
  if (!l) return null;
  const layout = await db.query("SELECT entries FROM listing_photo_layout WHERE listing_id = $1::uuid ORDER BY version DESC LIMIT 1", [listingId]);
  let ids: string[];
  if (layout.rows[0]) {
    ids = (layout.rows[0]["entries"] as { photoId?: unknown; hidden?: unknown }[]).filter(e => e.hidden !== true && typeof e.photoId === "string").map(e => e.photoId as string);
    const kinds = await db.query("SELECT id::text AS id FROM listing_photo WHERE listing_id = $1::uuid AND kind = 'photo'", [listingId]);
    const photos = new Set(kinds.rows.map(x => String(x["id"])));
    ids = ids.filter(i => photos.has(i));
  } else {
    ids = (await db.query("SELECT id::text AS id FROM listing_photo WHERE listing_id = $1::uuid AND kind = 'photo' ORDER BY uploaded_at", [listingId])).rows.map(x => String(x["id"]));
  }
  const base = env["APP_URL"]?.replace(/\/+$/, "") ?? "";
  return {
    id: String(l["id"]), title: String(l["title"]), description: typeof l["description"] === "string" ? l["description"] : null,
    propertyType: String(l["property_type"]), transactionType: String(l["transaction_type"]), address: String(l["address_text"]),
    suburb: typeof l["suburb"] === "string" ? l["suburb"] : null, state: String(l["jurisdiction"]).trim(), status: String(l["status"]),
    bedrooms: l["bedrooms"] === null ? null : Number(l["bedrooms"]), priceCents: l["price_cents"] === null ? null : Number(l["price_cents"]),
    updatedAt: iso(l["updated_at"])!, photoUrls: base ? ids.map(i => `${base}${photoUrl(i)}`) : [], listingUrl: base ? `${base}/listings/${listingId}` : null
  };
}

type Action = "create" | "update" | "remove";
interface CallResult { ok: boolean; status: number | null; externalId?: string; externalUrl?: string; error?: string }

/** One call to a portal's partner API (our contract: POST /listings, PUT /listings/{id}, DELETE /listings/{id}; Bearer key; JSON). Never throws. */
async function callPortal(deps: SyndicationDeps, p: { row: PortalRow; secrets: PortalSecrets }, action: Action, externalId: string | null, payload: PortalPayload | null, idemKey: string): Promise<CallResult> {
  if (!p.row.baseUrl || !p.secrets.apiKey) return { ok: false, status: null, error: "Portal is not configured." };
  const url = action === "create" ? `${p.row.baseUrl}/listings` : `${p.row.baseUrl}/listings/${encodeURIComponent(externalId ?? "")}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, {
      method: action === "create" ? "POST" : action === "update" ? "PUT" : "DELETE",
      headers: { authorization: `Bearer ${p.secrets.apiKey}`, "content-type": "application/json", "idempotency-key": idemKey },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: ctl.signal
    });
    const text = await res.text().catch(() => "");
    if (res.status >= 200 && res.status < 300 || (action === "remove" && res.status === 404)) {
      let body: Record<string, unknown> = {};
      try { const j: unknown = JSON.parse(text); if (j && typeof j === "object") body = j as Record<string, unknown>; } catch { /* empty body is fine */ }
      const id = typeof body["id"] === "string" ? body["id"] : typeof body["id"] === "number" ? String(body["id"]) : undefined;
      const link = typeof body["url"] === "string" && body["url"].startsWith("https://") && body["url"].length <= 500 ? body["url"] : undefined;
      return { ok: true, status: res.status, ...(id ? { externalId: id } : {}), ...(link ? { externalUrl: link } : {}) };
    }
    return { ok: false, status: res.status, error: safeError(`Portal answered ${res.status}: ${text.slice(0, 120)}`, [p.secrets.apiKey]) };
  } catch (e) {
    return { ok: false, status: null, error: safeError(ctl.signal.aborted ? "Portal did not answer in time." : e, [p.secrets.apiKey]) };
  } finally { clearTimeout(timer); }
}

/** True while this portal is under its per-minute call limit (counted from the call log). */
async function underRateLimit(db: Queryable, portal: Portal, max: number, now: string): Promise<boolean> {
  const r = await db.query("SELECT count(*)::int AS n FROM syndication_log WHERE portal = $1 AND at > $2::timestamptz - interval '60 seconds'", [portal, now]);
  return Number(r.rows[0]?.["n"]) < max;
}
const logCall = (db: Queryable, portal: Portal, listingId: string, action: Action, r: CallResult, now: string) =>
  db.query("INSERT INTO syndication_log (portal, listing_id, action, ok, http_status, error, at) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7::timestamptz)", [portal, listingId, action, r.ok, r.status, r.error ?? null, now]);

/** Takes the row's lease so two workers never push the same listing at once. False when someone else holds it. */
async function lease(db: Queryable, listingId: string, portal: Portal, now: string): Promise<boolean> {
  await db.query("INSERT INTO syndication_sync (listing_id, portal) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING", [listingId, portal]);
  const r = await db.query(
    `UPDATE syndication_sync SET lease_until = $3::timestamptz + interval '2 minutes'
      WHERE listing_id = $1::uuid AND portal = $2 AND (lease_until IS NULL OR lease_until < $3::timestamptz) RETURNING listing_id`, [listingId, portal, now]);
  return r.rows.length > 0;
}

export type SyncOutcome = "pushed" | "removed" | "unchanged" | "skipped" | "failed" | "rate_limited" | "manual";

/**
 * Brings one listing on one portal to the state it should be in: pushed (created or updated) when the listing is published, opted in and
 * allowed; removed when it is not. Manual portals only track the owner's link. Failures back off (1m, 5m, 30m, 2h, 6h) and then wait for a manual retry.
 */
export async function syncOne(db: Queryable, deps: SyndicationDeps, listingId: string, portal: Portal, opts: { force?: boolean } = {}): Promise<SyncOutcome> {
  const now = deps.now();
  const p = await loadPortal(db, portal, deps.env);
  if (!p) return "skipped";
  if (!(await lease(db, listingId, portal, now))) return "skipped";
  try {
    const listing = await loadSyndicationListing(db, listingId, deps.env);
    const set = (await db.query("SELECT enabled, custom, manual_url FROM syndication_listing_setting WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal])).rows[0];
    const sync = (await db.query("SELECT state, external_id, content_hash, attempts, last_synced_at FROM syndication_sync WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal])).rows[0]!;
    const wanted = !!listing && p.row.ready && set?.["enabled"] === true && ineligibleReason(listing, p.row.allowedTransactionTypes) === null;
    const externalId = typeof sync["external_id"] === "string" ? sync["external_id"] : null;
    const state = String(sync["state"]) as SyncState;
    const save = (patch: { state: SyncState; externalId?: string | null; externalUrl?: string | null; hash?: string | null; attempts: number; next: string | null; error: string | null; synced?: boolean }) =>
      db.query(
        `UPDATE syndication_sync SET state = $3, external_id = COALESCE($4, external_id), external_url = COALESCE($5, external_url), content_hash = COALESCE($6, content_hash),
                attempts = $7, next_attempt_at = $8::timestamptz, last_error = $9, last_synced_at = CASE WHEN $10::boolean THEN $11::timestamptz ELSE last_synced_at END,
                lease_until = NULL, updated_at = $11::timestamptz WHERE listing_id = $1::uuid AND portal = $2`,
        [listingId, portal, patch.state, patch.externalId ?? null, patch.externalUrl ?? null, patch.hash ?? null, patch.attempts, patch.next, patch.error, patch.synced === true, now]);

    if (p.row.mode === "channex") {
      return await syncChannex(db, deps, { listingId, portal, listing, wanted, state, externalId, attempts: Number(sync["attempts"]), maxPerMinute: p.row.maxPerMinute, force: opts.force === true, save, now });
    }

    if (p.row.mode === "manual") {
      const url = typeof set?.["manual_url"] === "string" ? set["manual_url"] : null;
      if (wanted) { await save({ state: "manual", externalUrl: url, attempts: 0, next: null, error: null, synced: true }); return "manual"; }
      const needsRemoval = state === "manual" || state === "manual_removal";
      await save({ state: needsRemoval ? "manual_removal" : "removed", attempts: 0, next: null, error: null });
      return needsRemoval ? "manual" : "skipped";
    }

    if (!wanted) {
      if (!externalId || state === "removed") { await save({ state: "removed", attempts: 0, next: null, error: null }); return "skipped"; }
      if (!(await underRateLimit(db, portal, p.row.maxPerMinute, now))) { await db.query("UPDATE syndication_sync SET lease_until = NULL WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]); return "rate_limited"; }
      const r = await callPortal(deps, p, "remove", externalId, null, `rm-${listingId}-${portal}`);
      await logCall(db, portal, listingId, "remove", r, now);
      const attempts = Number(sync["attempts"]) + 1;
      if (r.ok) {
        await save({ state: "removed", attempts: 0, next: null, error: null, synced: true });
        await db.query("UPDATE syndication_sync SET external_id = NULL, external_url = NULL, content_hash = NULL WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]);
        await audit(db, "system", "syndication", "listing", listingId, "syndication.delisted", { portal }, now);
        return "removed";
      }
      await save({ state: "failed", attempts, next: nextAttemptAt(now, attempts), error: r.error ?? null });
      return "failed";
    }

    const payload = buildPortalPayload(listing!, (set?.["custom"] as PortalCustomFields | undefined) ?? {});
    const hash = payloadHash(payload);
    const last = sync["last_synced_at"] ? Date.parse(iso(sync["last_synced_at"])!) : 0;
    const stale = Date.parse(now) - last > STALE_AFTER_HOURS * 3_600_000;
    if (state === "live" && sync["content_hash"] === hash && !stale && !opts.force) { await db.query("UPDATE syndication_sync SET lease_until = NULL WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]); return "unchanged"; }
    if (!(await underRateLimit(db, portal, p.row.maxPerMinute, now))) { await db.query("UPDATE syndication_sync SET lease_until = NULL WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]); return "rate_limited"; }
    const action: Action = externalId ? "update" : "create";
    const r = await callPortal(deps, p, action, externalId, payload, `push-${listingId}-${portal}-${hash.slice(0, 16)}`);
    await logCall(db, portal, listingId, action, r, now);
    if (r.ok) {
      const id = r.externalId ?? externalId;
      if (!id) { await save({ state: "failed", attempts: MAX_ATTEMPTS, next: null, error: "Portal accepted the listing but returned no id." }); return "failed"; }
      await save({ state: "live", externalId: id, externalUrl: r.externalUrl ?? null, hash, attempts: 0, next: null, error: null, synced: true });
      await audit(db, "system", "syndication", "listing", listingId, action === "create" ? "syndication.published" : "syndication.updated", { portal }, now);
      return "pushed";
    }
    const attempts = Number(sync["attempts"]) + 1;
    await save({ state: "failed", attempts, next: nextAttemptAt(now, attempts), error: r.error ?? null });
    return "failed";
  } catch (e) {
    await db.query("UPDATE syndication_sync SET lease_until = NULL, state = 'failed', last_error = $3, updated_at = $4::timestamptz WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal, safeError(e), now]).catch(() => undefined);
    return "failed";
  }
}

// ---- Channex (one channel manager for Airbnb, Booking.com and Vrbo) --------------------------------------------------------------

type SavePatch = { state: SyncState; externalId?: string | null; externalUrl?: string | null; hash?: string | null; attempts: number; next: string | null; error: string | null; synced?: boolean };
interface ChannexSyncInput {
  listingId: string; portal: Portal; listing: SyndicationListing | null; wanted: boolean; state: SyncState; externalId: string | null; attempts: number;
  maxPerMinute: number; force: boolean; save: (p: SavePatch) => Promise<unknown>; now: string;
}
interface ChannexMapping {
  propertyId: string | null; roomTypeId: string | null; ratePlanId: string | null; contentHash: string | null; ariHash: string | null; ariClosed: boolean; connected: Portal[]; syncedAt: string | null;
}
type StepResult = { ok: true; propertyId: string | null; calls: number } | { ok: false; status: number | null; error: string };
const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const releaseSync = (db: Queryable, listingId: string, portal: Portal) =>
  db.query("UPDATE syndication_sync SET lease_until = NULL WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]);

/** Portals in channex mode that want this listing now (published, opted in, category allowed), in a fixed order. The first one's fields are used. */
async function channexWanted(db: Queryable, listingId: string): Promise<{ portal: Portal; custom: PortalCustomFields }[]> {
  const r = await db.query(
    `SELECT s.portal, s.custom FROM syndication_listing_setting s
       JOIN syndication_portal p ON p.portal = s.portal AND p.enabled AND p.mode = 'channex'
       JOIN property_listing l ON l.id = s.listing_id AND l.status = 'published' AND l.transaction_type = ANY(p.allowed_transaction_types)
      WHERE s.listing_id = $1::uuid AND s.enabled ORDER BY s.portal`, [listingId]);
  return r.rows.map(x => ({ portal: x["portal"] as Portal, custom: (x["custom"] as PortalCustomFields | undefined) ?? {} }));
}

async function bookedStays(db: Queryable, listingId: string, today: string): Promise<{ checkIn: string; checkOut: string }[]> {
  const r = await db.query(
    "SELECT to_char(check_in, 'YYYY-MM-DD') AS ci, to_char(check_out, 'YYYY-MM-DD') AS co FROM syndication_booking WHERE listing_id = $1::uuid AND status = 'confirmed' AND check_out > $2::date ORDER BY check_in",
    [listingId, today]);
  return r.rows.map(x => ({ checkIn: String(x["ci"]), checkOut: String(x["co"]) }));
}

const saveMapping = (db: Queryable, listingId: string, m: Partial<Record<"property_id" | "room_type_id" | "rate_plan_id" | "content_hash" | "ari_hash", string | null>> & { ari_closed?: boolean; connected_portals?: Portal[]; synced_at?: string }, now: string) => {
  const keys = Object.keys(m);
  const sets = keys.map((k, i) => `${k} = $${i + 2}${k === "synced_at" ? "::timestamptz" : k === "connected_portals" ? "::text[]" : ""}`);
  return db.query(`UPDATE channex_property SET ${[...sets, `updated_at = $${keys.length + 2}::timestamptz`].join(", ")} WHERE listing_id = $1::uuid`,
    [listingId, ...keys.map(k => (m as Record<string, unknown>)[k]), now]);
};

/**
 * One listing on one portal, through Channex. All portals of a listing share one Channex property, so the second portal to sync usually costs one call
 * (reading its channel). Turning a portal off switches off that portal's channel when it serves only this listing; when no portal wants the listing,
 * every night is closed so nothing more can be booked (the property and its history stay).
 */
async function syncChannex(db: Queryable, deps: SyndicationDeps, x: ChannexSyncInput): Promise<SyncOutcome> {
  const { listingId, portal, now } = x;
  const cfg = channexConfig(deps.env);
  if (!cfg) { await x.save({ state: "failed", attempts: MAX_ATTEMPTS, next: null, error: "Channex is not set up (CHANNEX_API_KEY)." }); return "failed"; }
  if (!x.wanted && (!x.externalId || x.state === "removed")) { await x.save({ state: "removed", attempts: 0, next: null, error: null }); return "skipped"; }
  await db.query("INSERT INTO channex_property (listing_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING", [listingId]);
  const got = await db.query(
    `UPDATE channex_property SET lease_until = $2::timestamptz + interval '2 minutes' WHERE listing_id = $1::uuid AND (lease_until IS NULL OR lease_until < $2::timestamptz)
     RETURNING property_id, room_type_id, rate_plan_id, content_hash, ari_hash, ari_closed, connected_portals, synced_at`, [listingId, now]);
  const row = got.rows[0];
  if (!row) { await releaseSync(db, listingId, portal); return "skipped"; }
  const str = (k: string) => (typeof row[k] === "string" ? (row[k] as string) : null);
  const m: ChannexMapping = {
    propertyId: str("property_id"), roomTypeId: str("room_type_id"), ratePlanId: str("rate_plan_id"), contentHash: str("content_hash"), ariHash: str("ari_hash"),
    ariClosed: row["ari_closed"] === true, connected: (row["connected_portals"] as Portal[] | null) ?? [], syncedAt: iso(row["synced_at"])
  };
  try {
    if (!(await underRateLimit(db, portal, x.maxPerMinute, now))) { await releaseSync(db, listingId, portal); return "rate_limited"; }
    const action: Action = !x.wanted ? "remove" : x.externalId ? "update" : "create";
    const r = x.wanted ? await channexPush(db, deps, cfg, x, m) : await channexStop(db, deps, cfg, x, m);
    if (r.ok && r.calls === 0 && x.wanted) { await releaseSync(db, listingId, portal); return "unchanged"; }
    if (!r.ok || r.calls > 0) await logCall(db, portal, listingId, action, r.ok ? { ok: true, status: 200 } : { ok: false, status: r.status, error: r.error }, now);
    if (r.ok && x.wanted) {
      await x.save({ state: "live", externalId: r.propertyId, attempts: 0, next: null, error: null, synced: true });
      await audit(db, "system", "syndication", "listing", listingId, action === "create" ? "syndication.published" : "syndication.updated", { portal, via: "channex" }, now);
      return "pushed";
    }
    if (r.ok) {
      await x.save({ state: "removed", attempts: 0, next: null, error: null, synced: true });
      await db.query("UPDATE syndication_sync SET external_id = NULL, external_url = NULL, content_hash = NULL WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]);
      await audit(db, "system", "syndication", "listing", listingId, "syndication.delisted", { portal, via: "channex" }, now);
      return "removed";
    }
    const attempts = x.attempts + 1;
    await x.save({ state: "failed", attempts, next: nextAttemptAt(now, attempts), error: r.error });
    return "failed";
  } finally {
    await db.query("UPDATE channex_property SET lease_until = NULL WHERE listing_id = $1::uuid", [listingId]);
  }
}

async function channexPush(db: Queryable, deps: SyndicationDeps, cfg: ChannexConfig, x: ChannexSyncInput, m: ChannexMapping): Promise<StepResult> {
  const { listingId, portal, now } = x;
  const wanted = await channexWanted(db, listingId);
  const content = buildChannexContent(x.listing!, wanted[0]?.custom ?? {});
  if (content.nightlyRateCents === null) return { ok: false, status: null, error: "Set a nightly price (or a weekly rent) before sharing on this portal." };
  const contentHash = hashOf(content);
  const today = now.slice(0, 10);
  const booked = await bookedStays(db, listingId, today);
  const stale = !m.syncedAt || Date.parse(now) - Date.parse(m.syncedAt) > STALE_AFTER_HOURS * 3_600_000;
  const ariFor = (ids: { propertyId: string; roomTypeId: string; ratePlanId: string }) => buildAri(ids, today, content, booked);
  if (m.propertyId && m.roomTypeId && m.ratePlanId && x.state === "live" && !x.force && !stale && !m.ariClosed && m.contentHash === contentHash
      && m.ariHash === hashOf(ariFor({ propertyId: m.propertyId, roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId })) && m.connected.includes(portal)) {
    return { ok: true, propertyId: m.propertyId, calls: 0 };
  }
  let calls = 0;
  const s = await ensureStructure(cfg, deps.fetch, { propertyId: m.propertyId, roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId }, content,
    async ids => { calls++; await saveMapping(db, listingId, { property_id: ids.propertyId, room_type_id: ids.roomTypeId, rate_plan_id: ids.ratePlanId }, now); });
  if (!s.ok) return s;
  if (!s.created && (m.contentHash !== contentHash || x.force)) {
    const r = await updateContent(cfg, deps.fetch, s.ids, content);
    calls++;
    if (!r.ok) return { ok: false, status: r.status, error: r.error ?? "Channex refused the update." };
  }
  await saveMapping(db, listingId, { content_hash: contentHash }, now);
  const ari = ariFor(s.ids);
  const ariHash = hashOf(ari);
  if (s.created || m.ariHash !== ariHash || m.ariClosed || stale || x.force) {
    const r = await pushAri(cfg, deps.fetch, ari);
    calls++;
    if (!r.ok) return { ok: false, status: r.status, error: r.error ?? "Channex refused the calendar." };
    await saveMapping(db, listingId, { ari_hash: ariHash, ari_closed: false }, now);
  }
  const ch = await listChannels(cfg, deps.fetch, s.ids.propertyId);
  calls++;
  let connected = m.connected;
  if (ch.ok) {
    for (const c of ch.channels) {
      if (c.portal === portal && !c.active && c.properties.length === 1 && c.properties[0] === s.ids.propertyId) {
        const r = await setChannelActive(cfg, deps.fetch, c.id, true);
        calls++;
        if (r.ok) c.active = true;
      }
    }
    connected = [...new Set(ch.channels.filter(c => c.active && c.portal !== null).map(c => c.portal!))].sort();
  }
  await saveMapping(db, listingId, { connected_portals: connected, synced_at: now }, now);
  return { ok: true, propertyId: s.ids.propertyId, calls };
}

async function channexStop(db: Queryable, deps: SyndicationDeps, cfg: ChannexConfig, x: ChannexSyncInput, m: ChannexMapping): Promise<StepResult> {
  const { listingId, portal, now } = x;
  if (!m.propertyId) return { ok: true, propertyId: null, calls: 0 };
  let calls = 0;
  const ch = await listChannels(cfg, deps.fetch, m.propertyId);
  calls++;
  if (!ch.ok) return { ok: false, status: null, error: ch.error };
  for (const c of ch.channels.filter(c => c.portal === portal && c.active)) {
    if (c.properties.some(p => p !== m.propertyId)) {
      return { ok: false, status: null, error: `This ${PORTAL_LABELS[portal]} connection also serves other listings. Remove this listing from it in the connection screen.` };
    }
    const r = await setChannelActive(cfg, deps.fetch, c.id, false);
    calls++;
    if (!r.ok) return { ok: false, status: r.status, error: r.error ?? "Channex did not switch the channel off." };
  }
  const others = (await channexWanted(db, listingId)).filter(w => w.portal !== portal);
  if (others.length === 0 && !m.ariClosed && m.roomTypeId && m.ratePlanId) {
    const r = await pushAri(cfg, deps.fetch, buildAri({ propertyId: m.propertyId, roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId }, now.slice(0, 10), null, [], true));
    calls++;
    if (!r.ok) return { ok: false, status: r.status, error: r.error ?? "Channex did not close the calendar." };
    await saveMapping(db, listingId, { ari_closed: true, ari_hash: null }, now);
  }
  await saveMapping(db, listingId, { connected_portals: m.connected.filter(p => p !== portal) }, now);
  return { ok: true, propertyId: m.propertyId, calls };
}

export type RevisionOutcome = "confirmed" | "conflict" | "cancelled" | "changed" | "duplicate" | "unknown" | "ignored";

/** Stores one Channex booking revision against its listing. A changed stay keeps its row: new dates, re-checked for a clash. Other OTAs are ignored. */
export async function applyChannexRevision(db: Queryable, deps: SyndicationDeps, rev: ChannexRevision): Promise<RevisionOutcome> {
  const r = await db.query(
    "SELECT c.listing_id::text AS listing_id, l.owner_user_id::text AS owner, l.address_text FROM channex_property c JOIN property_listing l ON l.id = c.listing_id WHERE c.property_id = $1",
    [rev.propertyId]);
  const row = r.rows[0];
  const portal = rev.portal;
  if (!row || !portal) return "ignored";
  const listingId = String(row["listing_id"]);
  const now = deps.now();
  const e: IncomingBooking = {
    event: rev.status === "cancelled" ? "booking.cancelled" : "booking.created", externalListingId: rev.propertyId, externalBookingId: rev.bookingId,
    guestName: rev.guestName, guests: rev.guests, checkIn: rev.checkIn, checkOut: rev.checkOut, totalCents: rev.totalCents
  };
  const outcome: RevisionOutcome = await inTx(db, async tx => {
    if (rev.status === "modified") {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`syndication:${listingId}`]);
      const ex = (await tx.query("SELECT id FROM syndication_booking WHERE portal = $1 AND external_booking_id = $2 AND status <> 'cancelled'", [portal, rev.bookingId])).rows[0];
      if (ex) {
        const clash = await tx.query(
          "SELECT 1 FROM syndication_booking WHERE listing_id = $1::uuid AND id <> $4 AND status = 'confirmed' AND NOT (source = 'ical' AND portal = $5) AND check_in < $3::date AND $2::date < check_out LIMIT 1",
          [listingId, rev.checkIn, rev.checkOut, ex["id"], portal]);
        const status = clash.rows.length > 0 ? "conflict" : "confirmed";
        await tx.query("UPDATE syndication_booking SET check_in = $2::date, check_out = $3::date, guests = $4, total_cents = $5, guest_name = $6, status = $7 WHERE id = $1",
          [ex["id"], rev.checkIn, rev.checkOut, rev.guests, rev.totalCents, rev.guestName, status]);
        await audit(tx, "system", "syndication", "listing", listingId, status === "confirmed" ? "syndication.booking_changed" : "syndication.booking_conflict", { portal, nights: nights(rev.checkIn, rev.checkOut) }, now);
        return status === "confirmed" ? "changed" : "conflict";
      }
    }
    return handleBooking(tx, portal, listingId, e, now);
  });
  const params = { listing: String(row["address_text"]), name: rev.guestName, link: `/listings/${listingId}/syndication` };
  if (outcome === "confirmed") await notifyUser(db, String(row["owner"]), "booking_received", params, deps.env);
  if (outcome === "conflict") await notifyUser(db, String(row["owner"]), "booking_conflict", params, deps.env);
  if (outcome === "confirmed" || outcome === "changed" || outcome === "cancelled") await db.query("UPDATE channex_property SET ari_hash = NULL WHERE listing_id = $1::uuid", [listingId]);
  return outcome;
}

/** Parse, store, then acknowledge. A revision that fails to store is not acknowledged, so the feed offers it again. */
async function takeRevision(db: Queryable, deps: SyndicationDeps, cfg: ChannexConfig, raw: unknown): Promise<RevisionOutcome | "failed"> {
  const p = parseChannexRevision(raw);
  if (!p.ok) return "failed";
  let outcome: RevisionOutcome;
  try { outcome = await applyChannexRevision(db, deps, p.value); } catch { return "failed"; }
  const ack = await ackRevision(cfg, deps.fetch, p.value.revisionId);
  return ack.ok ? outcome : "failed";
}

/** Periodic pull of unacknowledged booking revisions (Channex asks for this every 15-20 minutes even with the webhook on). */
export async function runChannexBookings(db: Queryable, deps: SyndicationDeps): Promise<{ stored: number; ignored: number; failed: number } | null> {
  const cfg = channexConfig(deps.env);
  if (!cfg) return null;
  const on = await db.query("SELECT 1 FROM syndication_portal WHERE enabled AND mode = 'channex' LIMIT 1");
  if (on.rows.length === 0) return null;
  const feed = await revisionFeed(cfg, deps.fetch);
  const counts = { stored: 0, ignored: 0, failed: feed.ok ? 0 : 1 };
  for (const raw of feed.ok && Array.isArray(feed.data) ? feed.data : []) {
    const o = await takeRevision(db, deps, cfg, raw);
    if (o === "failed") counts.failed++; else if (o === "ignored") counts.ignored++; else counts.stored++;
  }
  return counts;
}

/**
 * Channex webhook. Verified (HMAC or shared secret header, see verifyChannexWebhook) before anything is read; 404 while CHANNEX_WEBHOOK_SECRET is unset.
 * Booking events carry only ids, so the revision is fetched, stored and acknowledged. Answers 200 once verified so Channex does not retry; the feed pull catches anything missed.
 */
export async function handleChannexWebhook(db: Queryable, deps: SyndicationDeps, rawBody: string, h: { timestamp: string | null; signature: string | null; sharedSecret: string | null }): Promise<WebhookResult> {
  const cfg = channexConfig(deps.env);
  if (!cfg?.webhookSecret) return { status: 404, body: { error: "Not found." } };
  if (!verifyChannexWebhook(cfg.webhookSecret, rawBody, h, Math.floor(Date.parse(deps.now()) / 1000))) return { status: 401, body: { error: "Bad signature." } };
  let json: Record<string, unknown>;
  try { const j: unknown = JSON.parse(rawBody); if (!j || typeof j !== "object") throw new Error(); json = j as Record<string, unknown>; } catch { return { status: 400, body: { error: "Send JSON." } }; }
  const event = typeof json["event"] === "string" ? json["event"] : "";
  const payload = (json["payload"] && typeof json["payload"] === "object" ? json["payload"] : {}) as Record<string, unknown>;
  const revisionId = typeof payload["revision_id"] === "string" && payload["revision_id"].length <= 64 ? payload["revision_id"] : null;
  if (!event.startsWith("booking") || !revisionId) return { status: 200, body: { status: "ignored" } };
  const rev = await getRevision(cfg, deps.fetch, revisionId);
  if (!rev.ok) return { status: 200, body: { status: "later" } };
  return { status: 200, body: { status: await takeRevision(db, deps, cfg, rev.data) } };
}

export type ConnectResult = { ok: true; url: string } | { ok: false; error: string; code: "not_configured" | "not_synced" | "failed" };

/** Owner: a one-time address of Channex's channel screen for this listing, where they connect their own Airbnb, Booking.com or Vrbo account. */
export async function channexConnectUrl(db: Queryable, deps: SyndicationDeps, userId: string, listingId: string): Promise<ConnectResult> {
  const cfg = channexConfig(deps.env);
  const portals = (await listPortals(db)).filter(p => p.enabled && p.mode === "channex").map(p => p.portal);
  if (!cfg || portals.length === 0) return { ok: false, error: "Connecting portal accounts is not switched on yet.", code: "not_configured" };
  const r = await db.query("SELECT property_id FROM channex_property WHERE listing_id = $1::uuid AND property_id IS NOT NULL", [listingId]);
  const propertyId = r.rows[0]?.["property_id"];
  if (typeof propertyId !== "string") return { ok: false, error: "Share the listing on a portal first, then connect your account.", code: "not_synced" };
  const u = await channelScreenUrl(cfg, deps.fetch, propertyId, userId, portals);
  if (!u.ok) return { ok: false, error: "Could not open the connection screen. Please try again in a minute.", code: "failed" };
  await audit(db, "user", userId, "listing", listingId, "syndication.connect_opened", { portals }, deps.now());
  return u;
}

/** Best effort right after a publish, toggle or withdrawal: never throws, never blocks the caller's action. */
export async function syndicateListing(db: Queryable, deps: SyndicationDeps, listingId: string): Promise<void> {
  try {
    const rows = await db.query(
      `SELECT portal FROM syndication_listing_setting WHERE listing_id = $1::uuid UNION SELECT portal FROM syndication_sync WHERE listing_id = $1::uuid`, [listingId]);
    for (const r of rows.rows) await syncOne(db, deps, listingId, r["portal"] as Portal);
  } catch { /* the periodic run retries */ }
}

export interface RunCounts { pushed: number; removed: number; unchanged: number; failed: number; rateLimited: number; skipped: number }

/**
 * Periodic tick (cron). Finds work from the database, so every route out of "published" (suspend, withdraw, archive, account deletion) de-lists too:
 *  - opted-in published listings that are new, changed, stale or due for retry, and
 *  - synced listings that should no longer be on the portal.
 */
export async function runSyndication(db: Queryable, deps: SyndicationDeps): Promise<RunCounts> {
  const now = deps.now();
  const counts: RunCounts = { pushed: 0, removed: 0, unchanged: 0, failed: 0, rateLimited: 0, skipped: 0 };
  const due = await db.query(
    `SELECT s.listing_id::text AS listing_id, s.portal FROM syndication_listing_setting s
       JOIN property_listing l ON l.id = s.listing_id
       JOIN syndication_portal p ON p.portal = s.portal AND p.enabled AND l.transaction_type = ANY(p.allowed_transaction_types)
       LEFT JOIN syndication_sync y ON y.listing_id = s.listing_id AND y.portal = s.portal
      WHERE s.enabled AND l.status = 'published'
        AND (y.listing_id IS NULL OR y.state IN ('pending', 'removed', 'manual_removal')
             OR (y.state = 'failed' AND y.next_attempt_at IS NOT NULL AND y.next_attempt_at <= $1::timestamptz)
             OR (y.state IN ('live', 'manual') AND (l.updated_at > y.last_synced_at OR y.last_synced_at < $1::timestamptz - make_interval(hours => $2::int)))
             OR (y.state = 'live' AND p.mode = 'channex' AND EXISTS (SELECT 1 FROM channex_property c WHERE c.listing_id = s.listing_id AND c.ari_hash IS NULL AND NOT c.ari_closed)))
        AND (y.lease_until IS NULL OR y.lease_until < $1::timestamptz)
      ORDER BY y.last_synced_at NULLS FIRST LIMIT $3`, [now, STALE_AFTER_HOURS, BATCH]);
  const gone = await db.query(
    `SELECT y.listing_id::text AS listing_id, y.portal FROM syndication_sync y
       JOIN property_listing l ON l.id = y.listing_id
       JOIN syndication_portal p ON p.portal = y.portal
       LEFT JOIN syndication_listing_setting s ON s.listing_id = y.listing_id AND s.portal = y.portal
      WHERE (y.state IN ('live', 'pending', 'manual') OR (y.state = 'failed' AND y.external_id IS NOT NULL AND y.next_attempt_at IS NOT NULL AND y.next_attempt_at <= $2::timestamptz))
        AND (l.status <> 'published' OR s.enabled IS NOT TRUE OR NOT p.enabled OR NOT (l.transaction_type = ANY(p.allowed_transaction_types)))
        AND (y.lease_until IS NULL OR y.lease_until < $2::timestamptz)
      LIMIT $1`, [BATCH, now]);
  const seen = new Set<string>();
  for (const r of [...gone.rows, ...due.rows]) {
    const k = `${r["listing_id"]}:${r["portal"]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const o = await syncOne(db, deps, String(r["listing_id"]), r["portal"] as Portal);
    if (o === "pushed") counts.pushed++; else if (o === "removed") counts.removed++; else if (o === "unchanged") counts.unchanged++;
    else if (o === "failed") counts.failed++; else if (o === "rate_limited") counts.rateLimited++; else counts.skipped++;
  }
  return counts;
}

/** Staff: a failed sync goes back in the queue now with its attempts reset. */
export async function retrySync(db: Queryable, staff: StaffActor, listingId: string, portal: Portal, now: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE syndication_sync SET state = CASE WHEN external_id IS NULL THEN 'pending' ELSE state END, attempts = 0, next_attempt_at = $3::timestamptz, lease_until = NULL, updated_at = $3::timestamptz
      WHERE listing_id = $1::uuid AND portal = $2 AND state = 'failed' RETURNING listing_id`, [listingId, portal, now]);
  if (r.rows.length === 0) return false;
  await audit(db, "user", staff.id, "listing", listingId, "syndication.retry_requested", { portal, role: staff.role }, now);
  return true;
}

export interface SyndicationOverview { portals: PortalRow[]; counts: Record<string, Record<string, number>>; failures: { listingId: string; title: string; portal: Portal; error: string | null; attempts: number; updatedAt: string }[] }
export async function overview(db: Queryable): Promise<SyndicationOverview> {
  const portals = await listPortals(db);
  const c = await db.query("SELECT portal, state, count(*)::int AS n FROM syndication_sync GROUP BY portal, state");
  const counts: Record<string, Record<string, number>> = Object.fromEntries(PORTALS.map(p => [p, {}]));
  for (const r of c.rows) counts[String(r["portal"])]![String(r["state"])] = Number(r["n"]);
  const f = await db.query(
    `SELECT y.listing_id::text AS listing_id, l.title, y.portal, y.last_error, y.attempts, y.updated_at FROM syndication_sync y
       JOIN property_listing l ON l.id = y.listing_id WHERE y.state = 'failed' ORDER BY y.updated_at DESC LIMIT 20`);
  return {
    portals, counts,
    failures: f.rows.map(r => ({ listingId: String(r["listing_id"]), title: String(r["title"]), portal: r["portal"] as Portal, error: typeof r["last_error"] === "string" ? r["last_error"] : null, attempts: Number(r["attempts"]), updatedAt: iso(r["updated_at"])! }))
  };
}

// ---- Bookings ---------------------------------------------------------------------------------------------------------------------------

export type WebhookResult = { status: number; body: Record<string, unknown> };
export const MAX_WEBHOOK_BYTES = 32_768;

/**
 * Inbound portal webhook. Verified with the portal's webhook secret (`t=<unix>,v1=<hmac>` over `<t>.<raw body>`, 5 minute window) before anything is read.
 * A booking is idempotent per (portal, external booking id). A stay that overlaps a confirmed one is recorded as a conflict (never double-booked)
 * and the owner is told. Always answers 200 for a well-formed event we have dealt with, so the portal does not keep retrying.
 */
export async function handleBookingWebhook(db: Queryable, deps: SyndicationDeps, portal: Portal, rawBody: string, signature: string | null): Promise<WebhookResult> {
  const p = await loadPortal(db, portal, deps.env);
  if (!p || !p.row.enabled || p.row.mode !== "api" || !p.secrets.webhookSecret) return { status: 404, body: { error: "Not found." } };
  if (!signature || !verifySignature(p.secrets.webhookSecret, rawBody, signature, Math.floor(Date.parse(deps.now()) / 1000))) return { status: 401, body: { error: "Bad signature." } };
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "Send JSON." } }; }
  const b = parseIncomingBooking(json);
  if (!b.ok) return { status: 400, body: { error: b.error } };
  const e = b.value;
  const sync = await db.query("SELECT s.listing_id::text AS listing_id, l.owner_user_id::text AS owner, l.address_text FROM syndication_sync s JOIN property_listing l ON l.id = s.listing_id WHERE s.portal = $1 AND s.external_id = $2", [portal, e.externalListingId]);
  const row = sync.rows[0];
  if (!row) return { status: 404, body: { error: "Unknown listing." } };
  const listingId = String(row["listing_id"]);
  const now = deps.now();
  const outcome = await inTx(db, async tx => handleBooking(tx, portal, listingId, e, now));
  const owner = String(row["owner"]);
  const params = { listing: String(row["address_text"]), name: e.guestName, link: `/listings/${listingId}/syndication` };
  if (outcome === "confirmed") await notifyUser(db, owner, "booking_received", params, deps.env);
  if (outcome === "conflict") await notifyUser(db, owner, "booking_conflict", params, deps.env);
  return { status: 200, body: { status: outcome } };
}

async function handleBooking(tx: Queryable, portal: Portal, listingId: string, e: IncomingBooking, now: string): Promise<"confirmed" | "conflict" | "cancelled" | "duplicate" | "unknown"> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`syndication:${listingId}`]);
  const existing = (await tx.query("SELECT id, status FROM syndication_booking WHERE portal = $1 AND external_booking_id = $2", [portal, e.externalBookingId])).rows[0];
  if (e.event === "booking.cancelled") {
    if (!existing) return "unknown";
    if (existing["status"] === "cancelled") return "duplicate";
    await tx.query("UPDATE syndication_booking SET status = 'cancelled', cancelled_at = $2::timestamptz WHERE id = $1", [existing["id"], now]);
    await audit(tx, "system", "syndication", "listing", listingId, "syndication.booking_cancelled", { portal, nights: nights(e.checkIn, e.checkOut) }, now);
    return "cancelled";
  }
  if (existing) return "duplicate";
  const clash = await tx.query(
    "SELECT 1 FROM syndication_booking WHERE listing_id = $1::uuid AND status = 'confirmed' AND NOT (source = 'ical' AND portal = $4) AND check_in < $3::date AND $2::date < check_out LIMIT 1",
    [listingId, e.checkIn, e.checkOut, portal]);
  const status = clash.rows.length > 0 ? "conflict" : "confirmed";
  await tx.query(
    `INSERT INTO syndication_booking (listing_id, portal, external_booking_id, guest_name, guests, check_in, check_out, total_cents, status, created_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10::timestamptz)`,
    [listingId, portal, e.externalBookingId, e.guestName, e.guests, e.checkIn, e.checkOut, e.totalCents, status, now]);
  await audit(tx, "system", "syndication", "listing", listingId, status === "confirmed" ? "syndication.booking_received" : "syndication.booking_conflict", { portal, nights: nights(e.checkIn, e.checkOut) }, now);
  return status;
}

export interface BookingView { id: string; portal: Portal; source: "webhook" | "ical"; guestName: string; guests: number | null; checkIn: string; checkOut: string; totalCents: number | null; status: string }
export async function listBookings(db: Queryable, listingId: string): Promise<BookingView[]> {
  const r = await db.query("SELECT id::text AS id, portal, source, guest_name, guests, to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out, total_cents, status FROM syndication_booking WHERE listing_id = $1::uuid ORDER BY check_in DESC LIMIT 200", [listingId]);
  return r.rows.map(x => ({
    id: String(x["id"]), portal: x["portal"] as Portal, source: x["source"] === "ical" ? "ical" : "webhook", guestName: String(x["guest_name"]), guests: x["guests"] === null ? null : Number(x["guests"]),
    checkIn: day(x["check_in"]), checkOut: day(x["check_out"]), totalCents: x["total_cents"] === null ? null : Number(x["total_cents"]), status: String(x["status"])
  }));
}

// ---- Calendar feed (iCal) -------------------------------------------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** New feed link for the listing; replaces any earlier one. Only the hash is stored, so the link is shown once. */
export async function rotateFeedToken(db: Queryable, userId: string, listingId: string, now: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await inTx(db, async tx => {
    await tx.query(
      "INSERT INTO syndication_feed (listing_id, token_hash, created_at) VALUES ($1::uuid, $2, $3::timestamptz) ON CONFLICT (listing_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = EXCLUDED.created_at",
      [listingId, sha(token), now]);
    await audit(tx, "user", userId, "listing", listingId, "syndication.feed_rotated", {}, now);
  });
  return token;
}

/** The iCal text for a feed token, or null. Booked dates only (confirmed stays booked through us; imported blocks are not echoed back, which would loop between portals), no guest details. */
export async function icalForToken(db: Queryable, token: string, now: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const f = await db.query("SELECT f.listing_id::text AS listing_id, l.title FROM syndication_feed f JOIN property_listing l ON l.id = f.listing_id WHERE f.token_hash = $1", [sha(token)]);
  const row = f.rows[0];
  if (!row) return null;
  const b = await db.query("SELECT id::text AS id, to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out FROM syndication_booking WHERE listing_id = $1::uuid AND status = 'confirmed' AND source = 'webhook' ORDER BY check_in", [row["listing_id"]]);
  return buildIcal(String(row["title"]), b.rows.map(x => ({ id: String(x["id"]), checkIn: day(x["check_in"]), checkOut: day(x["check_out"]) })), now);
}

// ---- Calendar import (blocked dates from the portal's iCal link) ------------------------------------------------------------------

const importField = (listingId: string, portal: Portal) => `syndication.calendar.${listingId}.${portal}`;
const SIX_HOURS = 21_600;

export interface CalendarImportView { portal: Portal; label: string; lastStatus: "ok" | "failed" | null; lastError: string | null; lastSyncedAt: string | null; blockedCount: number }

export async function listCalendarImports(db: Queryable, listingId: string): Promise<CalendarImportView[]> {
  const r = await db.query(
    `SELECT i.portal, i.last_status, i.last_error, i.last_synced_at,
            (SELECT count(*)::int FROM syndication_booking b WHERE b.listing_id = i.listing_id AND b.portal = i.portal AND b.source = 'ical' AND b.status <> 'cancelled' AND b.check_out >= current_date) AS blocked
       FROM syndication_calendar_import i WHERE i.listing_id = $1::uuid ORDER BY i.portal`, [listingId]);
  return r.rows.map(x => ({
    portal: x["portal"] as Portal, label: PORTAL_LABELS[x["portal"] as Portal], lastStatus: (x["last_status"] as "ok" | "failed" | null) ?? null,
    lastError: typeof x["last_error"] === "string" ? x["last_error"] : null, lastSyncedAt: iso(x["last_synced_at"]), blockedCount: Number(x["blocked"])
  }));
}

/** Saves (replaces) the portal's calendar link for a listing, sealed, then imports it at once so the owner sees the result. */
export async function saveCalendarImport(db: Queryable, deps: SyndicationDeps, userId: string, listingId: string, portal: Portal, rawUrl: unknown):
  Promise<{ ok: true; outcome: ImportOutcome } | { ok: false; error: string; code: "bad_url" | "key_not_configured" }> {
  const v = validateCalendarUrl(portal, rawUrl);
  if (!v.ok) return { ok: false, error: v.error, code: "bad_url" };
  const key = deps.env["SYNDICATION_SETTINGS_KEY"];
  if (!messagingKeyUsable(key)) return { ok: false, error: "Encryption key not configured. Nothing was saved.", code: "key_not_configured" };
  const enc = await sealSetting(v.value, key, importField(listingId, portal));
  const now = deps.now();
  await inTx(db, async tx => {
    await tx.query(
      `INSERT INTO syndication_calendar_import (listing_id, portal, url_enc, next_attempt_at, updated_by, updated_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::uuid, $4::timestamptz)
       ON CONFLICT (listing_id, portal) DO UPDATE SET url_enc = EXCLUDED.url_enc, attempts = 0, last_status = NULL, last_error = NULL,
         lease_until = NULL, next_attempt_at = EXCLUDED.next_attempt_at, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [listingId, portal, enc, now, userId]);
    await audit(tx, "user", userId, "listing", listingId, "syndication.calendar_import_saved", { portal }, now);
  });
  return { ok: true, outcome: await syncCalendarImport(db, deps, listingId, portal) };
}

/** Stops importing from a portal and releases the dates it was blocking. */
export async function removeCalendarImport(db: Queryable, userId: string, listingId: string, portal: Portal, now: string): Promise<boolean> {
  return inTx(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`syndication:${listingId}`]);
    const d = await tx.query("DELETE FROM syndication_calendar_import WHERE listing_id = $1::uuid AND portal = $2 RETURNING listing_id", [listingId, portal]);
    if (d.rows.length === 0) return false;
    await tx.query("UPDATE syndication_booking SET status = 'cancelled', cancelled_at = $3::timestamptz WHERE listing_id = $1::uuid AND portal = $2 AND source = 'ical' AND status <> 'cancelled'", [listingId, portal, now]);
    await audit(tx, "user", userId, "listing", listingId, "syndication.calendar_import_removed", { portal }, now);
    return true;
  });
}

export type ImportOutcome = "synced" | "failed" | "skipped" | "unconfigured";
const BLOCKED_NAME = "Blocked on portal";

/**
 * Imports one portal calendar. Fetches only the sealed link (never follows redirects), refuses anything that is not an iCal text, then in one
 * transaction: adds new blocks, moves changed ones, cancels blocks the portal no longer lists (future ones only) and marks a block "conflict" when it
 * overlaps a confirmed stay from a different portal. A failed fetch changes nothing, so a portal outage never frees dates.
 */
export async function syncCalendarImport(db: Queryable, deps: SyndicationDeps, listingId: string, portal: Portal): Promise<ImportOutcome> {
  const now = deps.now();
  const got = await db.query(
    `UPDATE syndication_calendar_import SET lease_until = $3::timestamptz + interval '2 minutes'
      WHERE listing_id = $1::uuid AND portal = $2 AND (lease_until IS NULL OR lease_until < $3::timestamptz) RETURNING url_enc, attempts`, [listingId, portal, now]);
  const rec = got.rows[0];
  if (!rec) {
    const exists = await db.query("SELECT 1 FROM syndication_calendar_import WHERE listing_id = $1::uuid AND portal = $2", [listingId, portal]);
    return exists.rows.length > 0 ? "skipped" : "unconfigured";
  }
  const fail = async (message: string): Promise<ImportOutcome> => {
    const attempts = Number(rec["attempts"]) + 1;
    const wait = nextRetryDelaySeconds(attempts) ?? SIX_HOURS;
    await db.query(
      "UPDATE syndication_calendar_import SET last_status = 'failed', last_error = $3, attempts = $4, next_attempt_at = $5::timestamptz, lease_until = NULL WHERE listing_id = $1::uuid AND portal = $2",
      [listingId, portal, safeError(message), attempts, new Date(Date.parse(now) + wait * 1000).toISOString()]);
    return "failed";
  };
  const key = deps.env["SYNDICATION_SETTINGS_KEY"];
  const url = messagingKeyUsable(key) ? await openSetting(String(rec["url_enc"]), key, importField(listingId, portal)).catch(() => undefined) : undefined;
  if (!url) return fail("The saved calendar link could not be read. Paste it again.");
  const check = validateCalendarUrl(portal, url);
  if (!check.ok) return fail(check.error);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let text: string;
  try {
    const res = await deps.fetch(check.value, { method: "GET", headers: { accept: "text/calendar, text/plain" }, signal: ctl.signal, redirect: "manual" });
    if (res.status !== 200) return await fail(`${PORTAL_LABELS[portal]} answered ${res.status}. Check the calendar link.`);
    text = await res.text();
  } catch (e) {
    return await fail(ctl.signal.aborted ? `${PORTAL_LABELS[portal]} did not answer in time.` : safeError(e, [url]));
  } finally { clearTimeout(timer); }
  if (text.length > MAX_ICAL_BYTES) return fail("That calendar is too large.");
  const blocks = parseIcal(text);
  if (blocks === null) return fail("That link did not return a calendar.");

  const today = now.slice(0, 10);
  const listing = (await db.query("SELECT owner_user_id::text AS owner, address_text FROM property_listing WHERE id = $1::uuid", [listingId])).rows[0];
  const live = blocks.filter(b => b.checkOut >= today);
  let newClashes = 0;
  await inTx(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`syndication:${listingId}`]);
    const existing = (await tx.query(
      "SELECT id::text AS id, external_booking_id, status, to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out FROM syndication_booking WHERE listing_id = $1::uuid AND portal = $2 AND source = 'ical'",
      [listingId, portal])).rows;
    const byId = new Map(existing.map(r => [String(r["external_booking_id"]), r]));
    const listed = new Set<string>();
    for (const b of live) {
      const extId = `ical:${listingId}:${b.uid}`;
      listed.add(extId);
      const clash = await tx.query(
        "SELECT 1 FROM syndication_booking WHERE listing_id = $1::uuid AND portal <> $2 AND status = 'confirmed' AND check_in < $4::date AND $3::date < check_out LIMIT 1",
        [listingId, portal, b.checkIn, b.checkOut]);
      const status = clash.rows.length > 0 ? "conflict" : "confirmed";
      const row = byId.get(extId);
      if (!row) {
        await tx.query(
          `INSERT INTO syndication_booking (listing_id, portal, external_booking_id, guest_name, check_in, check_out, status, source, created_at)
           VALUES ($1::uuid,$2,$3,$4,$5::date,$6::date,$7,'ical',$8::timestamptz)`, [listingId, portal, extId, BLOCKED_NAME, b.checkIn, b.checkOut, status, now]);
        if (status === "conflict") newClashes++;
      } else if (row["status"] !== status || day(row["check_in"]) !== b.checkIn || day(row["check_out"]) !== b.checkOut) {
        await tx.query("UPDATE syndication_booking SET status = $2, check_in = $3::date, check_out = $4::date, cancelled_at = NULL WHERE id = $1::uuid", [row["id"], status, b.checkIn, b.checkOut]);
        if (status === "conflict" && row["status"] !== "conflict") newClashes++;
      }
    }
    for (const r of existing) {
      if (!listed.has(String(r["external_booking_id"])) && r["status"] !== "cancelled" && day(r["check_out"]) >= today) {
        await tx.query("UPDATE syndication_booking SET status = 'cancelled', cancelled_at = $2::timestamptz WHERE id = $1::uuid", [r["id"], now]);
      }
    }
    await tx.query(
      `UPDATE syndication_calendar_import SET last_status = 'ok', last_error = NULL, attempts = 0, last_synced_at = $3::timestamptz, last_event_count = $4,
              next_attempt_at = $3::timestamptz + make_interval(mins => $5::int), lease_until = NULL WHERE listing_id = $1::uuid AND portal = $2`,
      [listingId, portal, now, live.length, IMPORT_EVERY_MINUTES]);
    if (newClashes > 0) await audit(tx, "system", "syndication", "listing", listingId, "syndication.calendar_conflict", { portal, count: newClashes }, now);
  });
  if (newClashes > 0 && listing) {
    await notifyUser(db, String(listing["owner"]), "booking_conflict", { listing: String(listing["address_text"]), name: PORTAL_LABELS[portal], link: `/listings/${listingId}/syndication` }, deps.env);
  }
  return "synced";
}

/** Cron tick: imports every calendar that is due. */
export async function runCalendarImports(db: Queryable, deps: SyndicationDeps): Promise<{ synced: number; failed: number; skipped: number }> {
  const due = await db.query(
    "SELECT listing_id::text AS listing_id, portal FROM syndication_calendar_import WHERE next_attempt_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until < $1::timestamptz) ORDER BY next_attempt_at LIMIT $2",
    [deps.now(), BATCH]);
  const counts = { synced: 0, failed: 0, skipped: 0 };
  for (const r of due.rows) {
    const o = await syncCalendarImport(db, deps, String(r["listing_id"]), r["portal"] as Portal);
    if (o === "synced") counts.synced++; else if (o === "failed") counts.failed++; else counts.skipped++;
  }
  return counts;
}

export interface BlockedStay { id: string; listingId: string; listingTitle: string; portal: Portal; checkIn: string; checkOut: string; status: "confirmed" | "conflict"; source: "webhook" | "ical" }

/** Upcoming portal stays and blocks on the listings an agent is appointed to (not revoked), clashes first. */
export async function upcomingBlockedForAgent(db: Queryable, agentUserId: string, today: string): Promise<BlockedStay[]> {
  const r = await db.query(
    `SELECT b.id::text AS id, b.listing_id::text AS listing_id, l.title, b.portal, b.status, b.source,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out
       FROM syndication_booking b JOIN property_listing l ON l.id = b.listing_id
      WHERE b.status IN ('confirmed', 'conflict') AND b.check_out >= $2::date
        AND EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = b.listing_id AND a.agent_user_id = $1::uuid AND a.revoked_at IS NULL)
      ORDER BY (b.status = 'conflict') DESC, b.check_in LIMIT 100`, [agentUserId, today]);
  return r.rows.map(x => ({
    id: String(x["id"]), listingId: String(x["listing_id"]), listingTitle: String(x["title"]), portal: x["portal"] as Portal, checkIn: day(x["check_in"]), checkOut: day(x["check_out"]),
    status: x["status"] as "confirmed" | "conflict", source: x["source"] as "webhook" | "ical"
  }));
}
