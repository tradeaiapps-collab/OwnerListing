import { randomUUID } from "node:crypto";
import {
  BULK_ASYNC_ABOVE, BULK_MAX, csvRow, describeBulk, newPriceCents, planBulkItem, type BulkParams, type ListingFacts
} from "../domain/listing-bulk";
import { LISTING_FILTER_WHERE, listingFilterParams, type ListingFilters } from "./admin-moderation-db";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Staff bulk operations on listings, database side. Every listing is changed in its own transaction together with its audit event, so a
 * failure on one listing never half-applies and never stops the others. A run is a row in listing_bulk_job that records progress and
 * can be resumed from `processed` if the process dies part way.
 */

const CHUNK = 20;
const STALE_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v: unknown) => Number(v ?? 0);
const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));

export interface BulkActor { id: string; role: string }
export type Selection = { ids: string[] } | { filter: ListingFilters };

/** Publishing needs the whole publish gate, which lives with the app wiring; the route passes it in. Returns null when published, else why not. */
export interface BulkIo { publish: (listingId: string, actor: BulkActor, jobId: string, reason: string) => Promise<string | null> }

// ---- selection -------------------------------------------------------------

/** The listing ids a request names: explicit ids (live listings only) or everything the filter matches. Error text when over the limit. */
export async function resolveSelection(db: Queryable, sel: Selection): Promise<{ ids: string[] } | { error: string }> {
  if ("ids" in sel) {
    const ids = [...new Set(sel.ids)];
    if (ids.length === 0) return { error: "Select at least one listing." };
    if (ids.length > BULK_MAX) return { error: `Select at most ${BULK_MAX} listings at a time.` };
    if (!ids.every(i => UUID_RE.test(i))) return { error: "Unknown listing." };
    const live = await db.query(`SELECT id FROM property_listing WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]);
    const found = new Set(live.rows.map(r => String(r["id"])));
    return { ids: ids.filter(i => found.has(i)) };
  }
  const res = await db.query(
    `SELECT l.id FROM property_listing l WHERE ${LISTING_FILTER_WHERE} ORDER BY l.created_at DESC, l.id DESC LIMIT ${BULK_MAX + 1}`,
    listingFilterParams(sel.filter)
  );
  if (res.rows.length > BULK_MAX) return { error: `More than ${BULK_MAX} listings match. Narrow the filters or select fewer.` };
  if (res.rows.length === 0) return { error: "No listings match." };
  return { ids: res.rows.map(r => String(r["id"])) };
}

/** An agent by id or email who can take appointments (same account rule as the owner's invite). */
export async function resolveAgent(db: Queryable, input: string): Promise<string | null> {
  const v = input.trim();
  if (!v) return null;
  const res = UUID_RE.test(v)
    ? await db.query(`SELECT id FROM app_user WHERE id = $1::uuid AND user_type = 'agent' AND status NOT IN ('suspended','closed','deleted')`, [v])
    : await db.query(`SELECT id FROM app_user WHERE lower(email) = lower($1) AND user_type = 'agent' AND status NOT IN ('suspended','closed','deleted')`, [v]);
  return res.rows[0] ? String(res.rows[0]["id"]) : null;
}

// ---- facts and preview -----------------------------------------------------

const FACTS_SQL = `
  SELECT l.id, l.title, l.owner_user_id, l.status, l.transaction_type, l.use_class, l.property_type, l.price_cents, l.outcome, (l.deleted_at IS NOT NULL) AS deleted,
    (SELECT count(*)::int FROM formal_offer o WHERE o.listing_id = l.id AND o.status IN ('submitted','under_review','countered','accepted')) AS active_offers,
    (SELECT count(*)::int FROM inspection i WHERE i.listing_id = l.id AND i.status IN ('invited','accepted') AND i.scheduled_at > now()) AS active_bookings,
    (SELECT a.agent_user_id FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.revoked_at IS NULL) AS agent_user_id,
    EXISTS (SELECT 1 FROM listing_tag t WHERE t.listing_id = l.id AND t.tag = $2) AS has_tag
  FROM property_listing l WHERE l.id = ANY($1::uuid[])`;

const toFacts = (r: Record<string, unknown>): ListingFacts & { title: string } => ({
  id: String(r["id"]), title: String(r["title"]), ownerUserId: String(r["owner_user_id"]), status: String(r["status"]),
  transactionType: r["transaction_type"] === "rent" ? "rent" : "sale", useClass: r["use_class"] === "commercial" ? "commercial" : "residential",
  propertyType: String(r["property_type"]), priceCents: r["price_cents"] === null ? null : n(r["price_cents"]),
  outcome: r["outcome"] === null ? null : String(r["outcome"]), deleted: r["deleted"] === true,
  activeOffers: n(r["active_offers"]), activeBookings: n(r["active_bookings"]),
  agentUserId: r["agent_user_id"] === null ? null : String(r["agent_user_id"]), hasTag: r["has_tag"] === true
});

const tagOf = (p: BulkParams) => (p.action === "add_tag" ? p.tag : null);

async function loadFacts(db: Queryable, ids: string[], p: BulkParams, lock = false) {
  const res = await db.query(lock ? `${FACTS_SQL} FOR UPDATE OF l` : FACTS_SQL, [ids, tagOf(p)]);
  return res.rows.map(toFacts);
}

export interface BulkPreview {
  total: number; willChange: number; willSkip: number; summary: string;
  skipReasons: { reason: string; count: number }[];
  examples: { id: string; title: string; change: string }[];
}

/** What the run would do right now, without changing anything. The confirmation dialog shows it. */
export async function previewBulk(db: Queryable, actorId: string, ids: string[], p: BulkParams): Promise<BulkPreview> {
  const facts = await loadFacts(db, ids, p);
  const reasons = new Map<string, number>();
  const examples: BulkPreview["examples"] = [];
  let willChange = 0;
  for (const f of facts) {
    const plan = planBulkItem(actorId, f, p);
    if (plan.kind === "skip") reasons.set(plan.reason, (reasons.get(plan.reason) ?? 0) + 1);
    else { willChange++; if (examples.length < 5) examples.push({ id: f.id, title: f.title, change: plan.change }); }
  }
  return {
    total: facts.length, willChange, willSkip: facts.length - willChange, summary: describeBulk(p),
    skipReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count), examples
  };
}

// ---- one listing -----------------------------------------------------------

type ItemOutcome = { outcome: "done" } | { outcome: "skipped" | "failed"; message: string };
interface RunCtx { jobId: string; actor: BulkActor; reason: string; params: BulkParams }

const audit = (tx: Queryable, c: RunCtx, listingId: string, change: string) =>
  appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: c.actor.id, aggregateType: "listing", aggregateId: listingId,
    eventType: `listing.bulk_${c.params.action}`, correlationId: c.jobId,
    payload: { role: c.actor.role, action: c.params.action, params: c.params, change, reason: c.reason, bulkJobId: c.jobId, moderation: true }
  });

async function applyOne(db: Queryable, io: BulkIo, c: RunCtx, id: string): Promise<ItemOutcome> {
  const p = c.params;
  if (p.action === "publish") {
    const [f] = await loadFacts(db, [id], p);
    if (!f) return { outcome: "skipped", message: "Listing not found." };
    const plan = planBulkItem(c.actor.id, f, p);
    if (plan.kind === "skip") return { outcome: "skipped", message: plan.reason };
    const why = await io.publish(id, c.actor, c.jobId, c.reason);
    return why === null ? { outcome: "done" } : { outcome: "skipped", message: why };
  }
  return inTx(db, async (tx): Promise<ItemOutcome> => {
    const [f] = await loadFacts(tx, [id], p, true);
    if (!f) return { outcome: "skipped", message: "Listing not found." };
    const plan = planBulkItem(c.actor.id, f, p);
    if (plan.kind === "skip") return { outcome: "skipped", message: plan.reason };
    switch (p.action) {
      case "archive":
        await tx.query(`UPDATE property_listing SET status = 'archived', updated_at = now() WHERE id = $1`, [id]); break;
      case "delete":
        await tx.query(`UPDATE property_listing SET status = 'archived', deleted_at = now(), updated_at = now() WHERE id = $1`, [id]); break;
      case "set_status":
        await (p.status === "available"
          ? tx.query(`UPDATE property_listing SET outcome = NULL, status = 'draft', updated_at = now() WHERE id = $1`, [id])
          : tx.query(`UPDATE property_listing SET outcome = $2, status = 'archived', updated_at = now() WHERE id = $1`, [id, p.status]));
        break;
      case "add_tag":
        await tx.query(`INSERT INTO listing_tag (listing_id, tag, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, p.tag, c.actor.id]); break;
      case "set_property_type":
        await tx.query(`UPDATE property_listing SET property_type = $2, updated_at = now() WHERE id = $1`, [id, p.propertyType]); break;
      case "adjust_price": {
        const next = newPriceCents(f, p);
        if (typeof next === "string") return { outcome: "skipped", message: next };
        await tx.query(`UPDATE property_listing SET price_cents = $2, updated_at = now() WHERE id = $1`, [id, next]); break;
      }
      case "assign_agent": {
        const old = await tx.query(`SELECT scope, permissions FROM listing_agent_appointment WHERE listing_id = $1 AND revoked_at IS NULL FOR UPDATE`, [id]);
        const prev = old.rows[0];
        if (!prev) return { outcome: "skipped", message: "No agent appointed yet; the owner appoints first." };
        await tx.query(`UPDATE listing_agent_appointment SET revoked_at = now(), revoked_by = $2 WHERE listing_id = $1 AND revoked_at IS NULL`, [id, c.actor.id]);
        await tx.query(
          `INSERT INTO listing_agent_appointment (id, listing_id, agent_user_id, appointed_by, scope, appointed_at, permissions) VALUES ($1, $2, $3, $4, $5, now(), $6)`,
          [randomUUID(), id, p.agentId, c.actor.id, prev["scope"], prev["permissions"] ?? null]
        );
        break;
      }
      default: return { outcome: "skipped", message: "Unknown action." };
    }
    await audit(tx, c, id, plan.change);
    return { outcome: "done" };
  });
}

// ---- jobs ------------------------------------------------------------------

export interface BulkJob {
  id: string; action: string; reason: string; status: "queued" | "running" | "done" | "failed";
  total: number; processed: number; succeeded: number; skipped: number; failed: number;
  problems: { id: string; outcome: string; message: string }[];
  createdAt: string; finishedAt: string | null; async: boolean;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const toJob = (r: Record<string, unknown>): BulkJob => ({
  id: String(r["id"]), action: String(r["action"]), reason: String(r["reason"]), status: String(r["status"]) as BulkJob["status"],
  total: n(r["total"]), processed: n(r["processed"]), succeeded: n(r["succeeded"]), skipped: n(r["skipped"]), failed: n(r["failed"]),
  problems: Array.isArray(r["problems"]) ? (r["problems"] as BulkJob["problems"]) : [], createdAt: iso(r["created_at"]),
  finishedAt: r["finished_at"] ? iso(r["finished_at"]) : null, async: n(r["total"]) > BULK_ASYNC_ABOVE
});
const JOB_COLS = `id, action, reason, status, cardinality(listing_ids) AS total, processed, succeeded, skipped, failed, problems, created_at, finished_at`;

export async function getJob(db: Queryable, id: string): Promise<BulkJob | null> {
  if (!UUID_RE.test(id)) return null;
  const res = await db.query(`SELECT ${JOB_COLS} FROM listing_bulk_job WHERE id = $1`, [id]);
  return res.rows[0] ? toJob(res.rows[0]) : null;
}

export async function createJob(db: Queryable, actor: BulkActor, p: BulkParams, reason: string, ids: string[]): Promise<string> {
  const id = randomUUID();
  await inTx(db, async tx => {
    await tx.query(
      `INSERT INTO listing_bulk_job (id, created_by, actor_role, action, params, reason, listing_ids) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::uuid[])`,
      [id, actor.id, actor.role, p.action, JSON.stringify(p), reason, ids]
    );
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: actor.id, aggregateType: "listing_bulk_job", aggregateId: id,
      eventType: "listing.bulk_started", correlationId: id, payload: { role: actor.role, action: p.action, params: p, reason, count: ids.length, listingIds: ids }
    });
  });
  return id;
}

/**
 * Works through a job's listings in order, a few at a time, saving progress after each batch. Safe to call twice: only one caller wins the
 * claim, and a job whose runner stopped (no heartbeat for a minute) is claimed again and carries on from `processed`.
 */
export async function runJob(db: Queryable, io: BulkIo, jobId: string): Promise<BulkJob | null> {
  const claim = await db.query(
    `UPDATE listing_bulk_job SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
      WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND heartbeat_at < now() - make_interval(secs => $2)))
      RETURNING created_by, actor_role, params, reason, listing_ids, processed`,
    [jobId, STALE_SECONDS]
  );
  const row = claim.rows[0];
  if (!row) return getJob(db, jobId);
  const ctx: RunCtx = { jobId, actor: { id: String(row["created_by"]), role: String(row["actor_role"]) }, reason: String(row["reason"]), params: row["params"] as BulkParams };
  const ids = (row["listing_ids"] as string[]).map(String);
  for (let at = n(row["processed"]); at < ids.length; at += CHUNK) {
    const slice = ids.slice(at, at + CHUNK);
    let ok = 0, skipped = 0, failed = 0;
    const problems: { id: string; outcome: string; message: string }[] = [];
    for (const id of slice) {
      let r: ItemOutcome;
      try { r = await applyOne(db, io, ctx, id); } catch { r = { outcome: "failed", message: "Could not save this listing." }; }
      if (r.outcome === "done") ok++;
      else { if (r.outcome === "skipped") skipped++; else failed++; problems.push({ id, outcome: r.outcome, message: r.message }); }
    }
    await db.query(
      `UPDATE listing_bulk_job SET processed = $2, succeeded = succeeded + $3, skipped = skipped + $4, failed = failed + $5,
              problems = problems || $6::jsonb, heartbeat_at = now() WHERE id = $1`,
      [jobId, at + slice.length, ok, skipped, failed, JSON.stringify(problems)]
    );
  }
  await inTx(db, async tx => {
    await tx.query(`UPDATE listing_bulk_job SET status = 'done', finished_at = now(), heartbeat_at = now() WHERE id = $1`, [jobId]);
    const done = (await tx.query(`SELECT succeeded, skipped, failed FROM listing_bulk_job WHERE id = $1`, [jobId])).rows[0] ?? {};
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: ctx.actor.id, aggregateType: "listing_bulk_job", aggregateId: jobId,
      eventType: "listing.bulk_finished", correlationId: jobId, payload: { role: ctx.actor.role, action: ctx.params.action, succeeded: n(done["succeeded"]), skipped: n(done["skipped"]), failed: n(done["failed"]) }
    });
  });
  return getJob(db, jobId);
}

/** Open jobs that nobody is running: waiting for a minute or more, or running with no heartbeat. Used by the poll route and the scheduler. */
export async function stalledJobIds(db: Queryable, limit = 3): Promise<string[]> {
  const res = await db.query(
    `SELECT id FROM listing_bulk_job
      WHERE (status = 'queued' AND created_at < now() - make_interval(secs => $1))
         OR (status = 'running' AND heartbeat_at < now() - make_interval(secs => $1))
      ORDER BY created_at LIMIT $2`,
    [STALE_SECONDS, limit]
  );
  return res.rows.map(r => String(r["id"]));
}

/**
 * Starts a run. Up to BULK_ASYNC_ABOVE listings finish before this returns; larger runs return at once as queued and `background`
 * carries on after the response (progress via getJob).
 */
export async function startBulk(
  db: Queryable, io: BulkIo, actor: BulkActor, p: BulkParams, reason: string, ids: string[], background: (work: () => Promise<unknown>) => void
): Promise<BulkJob> {
  const id = await createJob(db, actor, p, reason, ids);
  if (ids.length > BULK_ASYNC_ABOVE) {
    background(() => runJob(db, io, id));
    return (await getJob(db, id))!;
  }
  return (await runJob(db, io, id))!;
}

// ---- export ----------------------------------------------------------------

/** CSV of the selected listings. No owner identity (same as the staff search). One audit event records who exported what. */
export async function exportListingsCsv(db: Queryable, actor: BulkActor, ids: string[]): Promise<string> {
  const res = await db.query(
    `SELECT l.id, l.title, l.status, l.outcome, l.transaction_type, l.property_type, l.use_class, l.jurisdiction, l.suburb, l.postcode, l.price_cents,
            l.bedrooms, l.bathrooms, l.parking, l.created_at,
            (SELECT string_agg(t.tag, '; ' ORDER BY t.tag) FROM listing_tag t WHERE t.listing_id = l.id) AS tags,
            (SELECT count(*)::int FROM formal_offer o WHERE o.listing_id = l.id) AS offers
       FROM property_listing l WHERE l.id = ANY($1::uuid[]) AND l.deleted_at IS NULL ORDER BY l.created_at DESC, l.id DESC`,
    [ids]
  );
  const head = ["id", "title", "status", "outcome", "sale_or_rent", "property_type", "use", "state", "suburb", "postcode", "price_aud", "bedrooms", "bathrooms", "parking", "tags", "offers", "created_at"];
  const lines = [csvRow(head)];
  for (const r of res.rows) {
    lines.push(csvRow([
      r["id"], r["title"], r["status"], r["outcome"], r["transaction_type"], r["property_type"], r["use_class"], String(r["jurisdiction"]).trim(), r["suburb"], r["postcode"],
      r["price_cents"] === null ? "" : (n(r["price_cents"]) / 100).toFixed(2), r["bedrooms"], r["bathrooms"], r["parking"], r["tags"], r["offers"], iso(r["created_at"])
    ]));
  }
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: actor.id, aggregateType: "listing_bulk_export", aggregateId: randomUUID(),
    eventType: "listing.bulk_exported", correlationId: randomUUID(), payload: { role: actor.role, count: res.rows.length, listingIds: res.rows.map(r => String(r["id"])) }
  });
  return `${lines.join("\r\n")}\r\n`;
}
