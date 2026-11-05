import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fetchFeed, type FetchFn, type FetchResult } from "../adapters/feed-providers";
import { createDraft, parseDraftInput, type Actor, type ListingServiceDeps } from "../domain/listing-service";
import {
  draftFromItem, eventsFor, FEED_LIMITS, inTerritory, mapReaxml, nextRunAt, parseTerritory, stableJson,
  type ConnectionInput, type FeedItem, type FeedProvider, type FeedSchedule, type Territory
} from "../domain/property-feed";
import { appendAuditPg, type Queryable } from "./db";
import { envWithStoredDomain } from "./provider-credentials-db";

/**
 * Storage and runs for property data feeds. Parameterised SQL only.
 * A run fetches (or receives) a feed, keeps the records inside the connection's territory, and for each record:
 * finds or creates the property, adds the history events the change implies (idempotent), and keeps the latest copy.
 */

export interface FeedConnection {
  id: string; provider: FeedProvider; label: string; agentUserId: string | null; territory: Territory; schedule: FeedSchedule;
  sourceUrl: string | null; hasPushToken: boolean; comparablesLicensed: boolean; licenceTerms: string | null; enabled: boolean;
  nextRunAt: string | null; lastRunAt: string | null; createdAt: string;
}
export interface FeedRunRow {
  id: string; connectionId: string; trigger: string; status: string; startedAt: string; finishedAt: string | null;
  fetched: number; created: number; updated: number; unchanged: number; skipped: number; rejected: number; events: number; error: string | null;
}
export interface RunCounts { fetched: number; created: number; updated: number; unchanged: number; skipped: number; rejected: number; events: number }

const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const CONN_COLS = `id, provider, label, agent_user_id, territory, schedule, source_url, push_token_hash IS NOT NULL AS has_push, comparables_licensed,
  licence_terms, enabled, next_run_at, last_run_at, created_at`;
function toConnection(r: Record<string, unknown>): FeedConnection {
  const t = parseTerritory(r["territory"]);
  return {
    id: String(r["id"]), provider: r["provider"] as FeedProvider, label: String(r["label"]), agentUserId: r["agent_user_id"] ? String(r["agent_user_id"]) : null,
    territory: t.ok ? t.value : { states: [], postcodes: [], suburbs: [] }, schedule: r["schedule"] as FeedSchedule,
    sourceUrl: r["source_url"] ? String(r["source_url"]) : null, hasPushToken: r["has_push"] === true, comparablesLicensed: r["comparables_licensed"] === true,
    licenceTerms: r["licence_terms"] ? String(r["licence_terms"]) : null, enabled: r["enabled"] === true,
    nextRunAt: iso(r["next_run_at"]), lastRunAt: iso(r["last_run_at"]), createdAt: iso(r["created_at"])!
  };
}
function toRun(r: Record<string, unknown>): FeedRunRow {
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    id: String(r["id"]), connectionId: String(r["connection_id"]), trigger: String(r["trigger"]), status: String(r["status"]),
    startedAt: iso(r["started_at"])!, finishedAt: iso(r["finished_at"]), fetched: n("fetched"), created: n("created"), updated: n("updated"),
    unchanged: n("unchanged"), skipped: n("skipped"), rejected: n("rejected"), events: n("events"), error: r["error"] ? String(r["error"]) : null
  };
}

const audit = (db: Queryable, actorId: string, id: string, eventType: string, payload: Record<string, unknown>, now: string) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId, aggregateType: "feed_connection", aggregateId: id, eventType, correlationId: randomUUID(), payload });

// ---- Connections ----

export async function listConnections(db: Queryable): Promise<(FeedConnection & { lastRun: FeedRunRow | null })[]> {
  const r = await db.query(`SELECT ${CONN_COLS} FROM feed_connection ORDER BY created_at DESC LIMIT 200`);
  const conns = r.rows.map(toConnection);
  if (!conns.length) return [];
  const runs = await db.query(
    `SELECT DISTINCT ON (connection_id) * FROM feed_run WHERE connection_id = ANY($1::uuid[]) ORDER BY connection_id, started_at DESC`, [conns.map(c => c.id)]
  );
  const last = new Map(runs.rows.map(x => [String(x["connection_id"]), toRun(x)]));
  return conns.map(c => ({ ...c, lastRun: last.get(c.id) ?? null }));
}

export async function getConnection(db: Queryable, id: string): Promise<FeedConnection | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query(`SELECT ${CONN_COLS} FROM feed_connection WHERE id = $1`, [id]);
  return r.rows[0] ? toConnection(r.rows[0]) : null;
}

export async function recentRuns(db: Queryable, connectionId: string, limit = 20): Promise<FeedRunRow[]> {
  const r = await db.query("SELECT * FROM feed_run WHERE connection_id = $1 ORDER BY started_at DESC LIMIT $2", [connectionId, limit]);
  return r.rows.map(toRun);
}

/**
 * Creates a connection. A CRM (REAXML) connection also gets a push token, returned once here and stored only as a hash.
 * The agent must be an agent account; otherwise the result is an error message.
 */
export async function createConnection(db: Queryable, staffId: string, input: ConnectionInput, now: string): Promise<{ ok: true; id: string; pushToken: string | null } | { ok: false; error: string }> {
  if (input.agentUserId) {
    const a = await db.query("SELECT user_type FROM app_user WHERE id = $1", [input.agentUserId]);
    if (a.rows[0]?.["user_type"] !== "agent") return { ok: false, error: "That user is not an agent account." };
  }
  const pushToken = input.provider === "reaxml" ? randomBytes(32).toString("base64url") : null;
  const r = await db.query(
    `INSERT INTO feed_connection (provider, label, agent_user_id, territory, schedule, source_url, push_token_hash, comparables_licensed, licence_terms, next_run_at, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
    [input.provider, input.label, input.agentUserId, JSON.stringify(input.territory), input.schedule, input.sourceUrl, pushToken ? sha(pushToken) : null,
      input.comparablesLicensed, input.licenceTerms, nextRunAt(input.schedule, now), staffId, now]
  );
  const id = String(r.rows[0]!["id"]);
  await audit(db, staffId, id, "feed.connection_created", { provider: input.provider, comparablesLicensed: input.comparablesLicensed, schedule: input.schedule }, now);
  return { ok: true, id, pushToken };
}

export async function setConnectionEnabled(db: Queryable, staffId: string, id: string, enabled: boolean, now: string): Promise<boolean> {
  const cur = await getConnection(db, id);
  if (!cur) return false;
  // Resuming schedules the next run from now; pausing keeps the date for the record but the scheduler skips paused connections.
  await db.query("UPDATE feed_connection SET enabled = $2, updated_at = $3, next_run_at = $4 WHERE id = $1",
    [id, enabled, now, enabled ? nextRunAt(cur.schedule, now) : cur.nextRunAt]);
  await audit(db, staffId, id, enabled ? "feed.connection_enabled" : "feed.connection_paused", {}, now);
  return true;
}

export async function rotatePushToken(db: Queryable, staffId: string, id: string, now: string): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  const r = await db.query("UPDATE feed_connection SET push_token_hash = $2, updated_at = $3 WHERE id = $1 AND provider = 'reaxml' RETURNING id", [id, sha(token), now]);
  if (!r.rows[0]) return null;
  await audit(db, staffId, id, "feed.push_token_rotated", {}, now);
  return token;
}

/** Constant-time check of a CRM's push token against the stored hash. A paused connection or one without a token never matches. */
export async function connectionForPush(db: Queryable, id: string, token: string): Promise<FeedConnection | null> {
  const c = await getConnection(db, id);
  if (!c || !c.enabled || c.provider !== "reaxml" || !token) return null;
  const r = await db.query("SELECT push_token_hash FROM feed_connection WHERE id = $1", [id]);
  const stored = r.rows[0]?.["push_token_hash"];
  if (typeof stored !== "string") return null;
  return timingSafeEqual(Buffer.from(sha(token)), Buffer.from(stored)) ? c : null;
}

// ---- Import ----

async function findOrCreateProperty(db: Queryable, i: FeedItem): Promise<string> {
  if (i.streetAddress) {
    const r = await db.query(
      "SELECT id FROM property WHERE lower(address_text) = lower($1) AND state = $2 AND (postcode IS NOT DISTINCT FROM $3::char(4)) ORDER BY created_at LIMIT 1",
      [i.address, i.state, i.postcode ?? null]
    );
    // Reuse the matched property but never change its facts: a feed must not rewrite what owners or other sources recorded.
    if (r.rows[0]) return String(r.rows[0]["id"]);
  }
  const r = await db.query(
    `INSERT INTO property (address_text, state, suburb, postcode, use_class, property_type, bedrooms, bathrooms, car_spaces, land_area_sqm, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [i.address, i.state, i.suburb, i.postcode ?? null, i.useClass, i.propertyType, i.bedrooms ?? null, i.bathrooms ?? null, i.parking ?? null, i.landAreaSqm ?? null, i.latitude ?? null, i.longitude ?? null]
  );
  return String(r.rows[0]!["id"]);
}

async function importItem(db: Queryable, conn: FeedConnection, item: FeedItem, now: string): Promise<{ kind: "created" | "updated" | "unchanged"; events: number }> {
  const hash = sha(stableJson(item));
  const ex = await db.query("SELECT content_hash, item, property_id FROM feed_record WHERE connection_id = $1 AND external_id = $2", [conn.id, item.externalId]);
  const prevRow = ex.rows[0];
  if (prevRow && prevRow["content_hash"] === hash) {
    await db.query("UPDATE feed_record SET last_seen_at = $3 WHERE connection_id = $1 AND external_id = $2", [conn.id, item.externalId, now]);
    return { kind: "unchanged", events: 0 };
  }
  const prev = prevRow ? (prevRow["item"] as FeedItem) : undefined;
  const propertyId = prevRow ? String(prevRow["property_id"]) : await findOrCreateProperty(db, item);
  let events = 0;
  for (const e of eventsFor(prev, item, now)) {
    const r = await db.query(
      `INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source, feed_connection_id, details)
       VALUES ($1,$2,$3,$4,'licensed_third_party',$5,$6::jsonb)
       ON CONFLICT (feed_connection_id, property_id, event_type, occurred_at) WHERE feed_connection_id IS NOT NULL DO NOTHING RETURNING id`,
      [propertyId, e.type, e.occurredAt, e.amountCents, conn.id, JSON.stringify({ provider: conn.provider, externalId: item.externalId })]
    );
    events += r.rows.length;
  }
  await db.query(
    `INSERT INTO feed_record (connection_id, external_id, content_hash, property_id, status, item, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET content_hash = EXCLUDED.content_hash, status = EXCLUDED.status, item = EXCLUDED.item, last_seen_at = EXCLUDED.last_seen_at`,
    [conn.id, item.externalId, hash, propertyId, item.status, JSON.stringify(item), now]
  );
  return { kind: prevRow ? "updated" : "created", events };
}

/** Imports a fetched (or pushed) feed into the connection and records the run. Always finishes the run row, even on failure. */
export async function importFeed(db: Queryable, conn: FeedConnection, result: FetchResult, trigger: "schedule" | "staff" | "push", now: string): Promise<FeedRunRow> {
  const run = await db.query("INSERT INTO feed_run (connection_id, trigger, started_at) VALUES ($1,$2,$3) RETURNING id", [conn.id, trigger, now]);
  const runId = String(run.rows[0]!["id"]);
  const c: RunCounts = { fetched: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, rejected: 0, events: 0 };
  let error: string | null = null;
  const rejects: { externalId?: string; reason: string }[] = [];
  if ("error" in result) error = result.error;
  else {
    c.fetched = result.items.length;
    c.rejected = result.rejected.length;
    rejects.push(...result.rejected.slice(0, 50));
    for (const item of result.items.slice(0, FEED_LIMITS.maxItemsPerRun)) {
      if (!inTerritory(conn.territory, item)) { c.skipped++; continue; }
      try {
        const r = db.transaction ? await db.transaction(tx => importItem(tx, conn, item, now)) : await importItem(db, conn, item, now);
        c[r.kind]++;
        c.events += r.events;
      } catch {
        c.rejected++;
        if (rejects.length < 50) rejects.push({ externalId: item.externalId, reason: "Could not be saved." });
      }
    }
    c.skipped += Math.max(0, result.items.length - FEED_LIMITS.maxItemsPerRun);
  }
  const r = await db.query(
    `UPDATE feed_run SET status = $2, finished_at = $3, fetched = $4, created = $5, updated = $6, unchanged = $7, skipped = $8, rejected = $9, events = $10, error = $11, rejects = $12::jsonb
      WHERE id = $1 RETURNING *`,
    [runId, error ? "failed" : "ok", new Date().toISOString(), c.fetched, c.created, c.updated, c.unchanged, c.skipped, c.rejected, c.events, error?.slice(0, 500) ?? null, JSON.stringify(rejects)]
  );
  await db.query("UPDATE feed_connection SET last_run_at = $2 WHERE id = $1", [conn.id, now]);
  return toRun(r.rows[0]!);
}

export async function runConnection(db: Queryable, conn: FeedConnection, trigger: "schedule" | "staff", fetchFn: FetchFn, env: Record<string, string | undefined>, now: string): Promise<FeedRunRow> {
  const runEnv = conn.provider === "domain" ? await envWithStoredDomain(db, env) : env;
  const result = await fetchFeed(fetchFn, { provider: conn.provider, sourceUrl: conn.sourceUrl, territory: conn.territory }, runEnv)
    .catch((): FetchResult => ({ error: "The fetch failed." }));
  return importFeed(db, conn, result, trigger, now);
}

/** A CRM's pushed REAXML document. */
export async function importPushedReaxml(db: Queryable, conn: FeedConnection, xml: string, now: string): Promise<FeedRunRow> {
  return importFeed(db, conn, mapReaxml(xml), "push", now);
}

/**
 * Scheduler tick: runs connections that are due (at most `max` per tick). Each is claimed by moving its next_run_at forward
 * first, with a compare-and-set, so two overlapping ticks never run the same connection.
 */
export async function runDueFeeds(db: Queryable, fetchFn: FetchFn, env: Record<string, string | undefined>, now: string, max = 10): Promise<FeedRunRow[]> {
  const due = await db.query(
    `SELECT ${CONN_COLS} FROM feed_connection WHERE enabled AND schedule <> 'manual' AND next_run_at IS NOT NULL AND next_run_at <= $1
      ORDER BY next_run_at LIMIT $2`, [now, max]
  );
  const out: FeedRunRow[] = [];
  for (const row of due.rows) {
    const conn = toConnection(row);
    const claimed = await db.query("UPDATE feed_connection SET next_run_at = $2 WHERE id = $1 AND next_run_at = $3::timestamptz RETURNING id", [conn.id, nextRunAt(conn.schedule, now), conn.nextRunAt]);
    if (!claimed.rows[0]) continue;
    // A push-only CRM feed has nothing to pull; it is not a failure.
    if (conn.provider === "reaxml" && !conn.sourceUrl) continue;
    out.push(await runConnection(db, conn, "schedule", fetchFn, env, now));
  }
  return out;
}

// ---- Agent workspace ----

export interface ImportedListing {
  connectionId: string; connectionLabel: string; externalId: string; status: string; lastSeenAt: string; draftListingId: string | null;
  item: FeedItem;
}

/** The signed-in agent's imported CRM listings (current ones first), newest first. */
export async function agentImports(db: Queryable, agentUserId: string): Promise<ImportedListing[]> {
  const r = await db.query(
    `SELECT r.connection_id, c.label, r.external_id, r.status, r.last_seen_at, r.draft_listing_id, r.item
       FROM feed_record r JOIN feed_connection c ON c.id = r.connection_id
      WHERE c.agent_user_id = $1 AND c.provider = 'reaxml'
      ORDER BY (r.status = 'active') DESC, r.last_seen_at DESC LIMIT 300`, [agentUserId]
  );
  return r.rows.map(x => ({
    connectionId: String(x["connection_id"]), connectionLabel: String(x["label"]), externalId: String(x["external_id"]), status: String(x["status"]),
    lastSeenAt: iso(x["last_seen_at"])!, draftListingId: x["draft_listing_id"] ? String(x["draft_listing_id"]) : null, item: x["item"] as FeedItem
  }));
}

export type StartDraftResult = { ok: true; listingId: string; created: boolean } | { ok: false; status: number; error: string };

/**
 * Starts a draft listing from one of the agent's imported CRM listings. The draft belongs to the agent and goes through
 * the normal checks (fee, terms, disclosures, trust account) before it can publish. One draft per record: asking again
 * returns the existing draft.
 */
export async function startDraftFromImport(db: Queryable, deps: ListingServiceDeps, actor: Actor, connectionId: string, externalId: string): Promise<StartDraftResult> {
  if (actor.userType !== "agent") return { ok: false, status: 403, error: "Only agents can import listings." };
  if (!/^[0-9a-f-]{36}$/i.test(connectionId) || !externalId || externalId.length > 200) return { ok: false, status: 404, error: "Imported listing not found." };
  const r = await db.query(
    `SELECT r.item, r.draft_listing_id, r.status FROM feed_record r JOIN feed_connection c ON c.id = r.connection_id
      WHERE r.connection_id = $1 AND r.external_id = $2 AND c.agent_user_id = $3 AND c.provider = 'reaxml'`,
    [connectionId, externalId, actor.userId]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, status: 404, error: "Imported listing not found." };
  if (row["draft_listing_id"]) return { ok: true, listingId: String(row["draft_listing_id"]), created: false };
  if (row["status"] !== "active") return { ok: false, status: 409, error: "Only current listings can become drafts." };
  const parsed = parseDraftInput(draftFromItem(row["item"] as FeedItem));
  if (!parsed.ok) return { ok: false, status: 422, error: `The CRM record is missing details: ${parsed.message}` };
  const listing = await createDraft(deps, actor, parsed.value);
  const linked = await db.query(
    "UPDATE feed_record SET draft_listing_id = $3 WHERE connection_id = $1 AND external_id = $2 AND draft_listing_id IS NULL RETURNING draft_listing_id",
    [connectionId, externalId, listing.id]
  );
  if (!linked.rows[0]) {
    // Another request linked a draft first; point at that one (ours stays as an unused draft the agent can delete).
    const again = await db.query("SELECT draft_listing_id FROM feed_record WHERE connection_id = $1 AND external_id = $2", [connectionId, externalId]);
    return { ok: true, listingId: String(again.rows[0]?.["draft_listing_id"] ?? listing.id), created: false };
  }
  await db.query("UPDATE property_listing SET property_id = (SELECT property_id FROM feed_record WHERE connection_id = $1 AND external_id = $2) WHERE id = $3", [connectionId, externalId, listing.id]);
  return { ok: true, listingId: listing.id, created: true };
}

export const feedTerritory = parseTerritory;
export type { Territory };
