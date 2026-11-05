import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readBrand } from "../config/brand";
import {
  figuresView, leadStage, renderFollowup, type FiguresView, type FollowupMode, type LeadInput, type LeadInterest, type LeadProvider, type LeadStatus,
  type MatchItem, type SourceInput
} from "../domain/lead-ads";
import { appendAuditPg, type Queryable } from "./db";
import { getEmailPort, sendNotice } from "./messaging";

/** Storage for lead ads. Parameterised SQL only; every staff write is audited. */

type Env = Readonly<Record<string, string | undefined>>;
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const audit = (db: Queryable, actorId: string | null, id: string, eventType: string, payload: Record<string, unknown>, now: string) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: actorId ? "user" : "service", actorId: actorId ?? "lead-webhook", aggregateType: "lead", aggregateId: id, eventType, correlationId: randomUUID(), payload });

export interface LeadSource {
  id: string; provider: LeadProvider; label: string; accountRef: string; defaultAgentId: string | null; defaultAgentName: string | null;
  followupMode: FollowupMode; enabled: boolean; createdAt: string;
}
const SRC_COLS = `s.id, s.provider, s.label, s.account_ref, s.default_agent_id, a.display_name AS agent_name, s.followup_mode, s.enabled, s.created_at, s.webhook_key_hash`;
const SRC_FROM = `FROM lead_source s LEFT JOIN app_user a ON a.id = s.default_agent_id`;
function toSource(r: Record<string, unknown>): LeadSource & { keyHash: string | null } {
  return {
    id: String(r["id"]), provider: r["provider"] as LeadProvider, label: String(r["label"]), accountRef: String(r["account_ref"]),
    defaultAgentId: r["default_agent_id"] ? String(r["default_agent_id"]) : null, defaultAgentName: r["agent_name"] ? String(r["agent_name"]) : null,
    followupMode: r["followup_mode"] as FollowupMode, enabled: r["enabled"] === true, createdAt: iso(r["created_at"])!, keyHash: r["webhook_key_hash"] ? String(r["webhook_key_hash"]) : null
  };
}
const publicSource = ({ keyHash: _k, ...s }: LeadSource & { keyHash: string | null }): LeadSource => s;

/** An active agent account, or null. Leads are only ever assigned to these. */
async function activeAgent(db: Queryable, id: string): Promise<{ id: string; name: string; email: string | null } | null> {
  const r = await db.query("SELECT id, display_name, email FROM app_user WHERE id = $1::uuid AND user_type = 'agent' AND status = 'active' AND deleted_at IS NULL", [id]);
  const x = r.rows[0];
  return x ? { id: String(x["id"]), name: String(x["display_name"]), email: x["email"] ? String(x["email"]) : null } : null;
}
export async function listAgents(db: Queryable): Promise<{ id: string; name: string }[]> {
  const r = await db.query("SELECT id, display_name FROM app_user WHERE user_type = 'agent' AND status = 'active' AND deleted_at IS NULL ORDER BY display_name LIMIT 500");
  return r.rows.map(x => ({ id: String(x["id"]), name: String(x["display_name"]) }));
}

// ---- Sources ----

export async function createSource(db: Queryable, staffId: string, input: SourceInput, now: string): Promise<{ ok: true; id: string; webhookKey: string | null } | { ok: false; error: string }> {
  if (input.defaultAgentId && !(await activeAgent(db, input.defaultAgentId))) return { ok: false, error: "That agent is not an active agent account." };
  // Google signs nothing, so it gets a key we check on every lead. Shown once here, stored only as a hash.
  const webhookKey = input.provider === "google" ? randomBytes(24).toString("base64url") : null;
  try {
    const r = await db.query(
      `INSERT INTO lead_source (provider, label, account_ref, webhook_key_hash, default_agent_id, followup_mode, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8::timestamptz,$8::timestamptz) RETURNING id`,
      [input.provider, input.label, input.accountRef, webhookKey ? sha(webhookKey) : null, input.defaultAgentId, input.followupMode, staffId, now]);
    const id = String(r.rows[0]!["id"]);
    await audit(db, staffId, id, "lead_source.created", { provider: input.provider, label: input.label }, now);
    return { ok: true, id, webhookKey };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, error: "That account is already connected." };
    throw e;
  }
}
export async function getSource(db: Queryable, id: string): Promise<LeadSource | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query(`SELECT ${SRC_COLS} ${SRC_FROM} WHERE s.id = $1::uuid`, [id]);
  return r.rows[0] ? publicSource(toSource(r.rows[0])) : null;
}
export async function sourceForMetaPage(db: Queryable, pageId: string): Promise<LeadSource | null> {
  const r = await db.query(`SELECT ${SRC_COLS} ${SRC_FROM} WHERE s.provider = 'meta' AND s.account_ref = $1 AND s.enabled`, [pageId]);
  return r.rows[0] ? publicSource(toSource(r.rows[0])) : null;
}
/** The Google source for this id when the key matches. Wrong id, wrong key and a paused source are indistinguishable (null). */
export async function sourceForGoogle(db: Queryable, id: string, key: string): Promise<LeadSource | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !key) return null;
  const r = await db.query(`SELECT ${SRC_COLS} ${SRC_FROM} WHERE s.id = $1::uuid AND s.provider = 'google' AND s.enabled`, [id]);
  const s = r.rows[0] ? toSource(r.rows[0]) : null;
  if (!s?.keyHash) return null;
  const a = Buffer.from(s.keyHash, "hex"), b = Buffer.from(sha(key), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? publicSource(s) : null;
}

export async function updateSource(db: Queryable, staffId: string, id: string, patch: { enabled?: boolean; followupMode?: FollowupMode; defaultAgentId?: string | null }, now: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (patch.defaultAgentId && !(await activeAgent(db, patch.defaultAgentId))) return { ok: false, error: "That agent is not an active agent account." };
  const sets: string[] = ["updated_at = $2::timestamptz"], params: unknown[] = [id, now];
  const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.enabled !== undefined) add("enabled", patch.enabled);
  if (patch.followupMode !== undefined) add("followup_mode", patch.followupMode);
  if (patch.defaultAgentId !== undefined) add("default_agent_id", patch.defaultAgentId);
  const r = await db.query(`UPDATE lead_source SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING id`, params);
  if (!r.rows[0]) return { ok: false, error: "Source not found." };
  await audit(db, staffId, id, "lead_source.updated", { ...patch }, now);
  return { ok: true };
}
export async function rotateGoogleKey(db: Queryable, staffId: string, id: string, now: string): Promise<string | null> {
  const key = randomBytes(24).toString("base64url");
  const r = await db.query("UPDATE lead_source SET webhook_key_hash = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND provider = 'google' RETURNING id", [id, sha(key), now]);
  if (!r.rows[0]) return null;
  await audit(db, staffId, id, "lead_source.key_rotated", {}, now);
  return key;
}

export async function recordSpend(db: Queryable, staffId: string, sourceId: string, rows: { day: string; spendCents: number }[], now: string): Promise<boolean> {
  if (!(await getSource(db, sourceId))) return false;
  await atomic(db, async tx => {
    for (const r of rows) {
      await tx.query(
        `INSERT INTO lead_spend (source_id, day, spend_cents, recorded_by, recorded_at) VALUES ($1::uuid,$2::date,$3,$4::uuid,$5::timestamptz)
         ON CONFLICT (source_id, day) DO UPDATE SET spend_cents = EXCLUDED.spend_cents, recorded_by = EXCLUDED.recorded_by, recorded_at = EXCLUDED.recorded_at`,
        [sourceId, r.day, r.spendCents, staffId, now]);
    }
    await audit(tx, staffId, sourceId, "lead_spend.recorded", { days: rows.length, totalCents: rows.reduce((n, r) => n + r.spendCents, 0) }, now);
  });
  return true;
}

// ---- Ingest ----

export interface IngestResult { created: boolean; leadId: string; followup: "none" | "sent" | "failed" | "skipped" }

/** Matching published listings for a follow-up: same deal type, in the lead's postcode or suburb (the newest when no area was given). */
async function matchesFor(db: Queryable, interest: LeadInterest | null, suburb: string | null, postcode: string | null): Promise<MatchItem[]> {
  if (interest !== "buying" && interest !== "renting") return [];
  const area = postcode ? "l.postcode = $2" : suburb ? "lower(l.suburb) = lower($2)" : "$2::text IS NULL";
  const r = await db.query(
    `SELECT l.id, l.title, l.address_text, l.price_cents, l.transaction_type FROM property_listing l
      WHERE l.status = 'published' AND l.transaction_type = $1 AND ${area} ORDER BY l.created_at DESC LIMIT 3`,
    [interest === "buying" ? "sale" : "rent", postcode ?? suburb]);
  return r.rows.map(x => ({ id: String(x["id"]), title: String(x["title"]), address: String(x["address_text"]), priceCents: x["price_cents"] === null ? null : Number(x["price_cents"]), transactionType: x["transaction_type"] as "sale" | "rent" }));
}

async function sendFollowup(db: Queryable, source: LeadSource, leadId: string, lead: LeadInput, env: Env): Promise<"sent" | "failed" | "skipped"> {
  if (source.followupMode === "off" || lead.isTest || !lead.email) return "skipped";
  try {
    const agent = source.defaultAgentId ? await activeAgent(db, source.defaultAgentId) : null;
    const matches = source.followupMode === "matches" ? await matchesFor(db, lead.interest, lead.suburb, lead.postcode) : [];
    const mail = renderFollowup({ brand: readBrand().name, appUrl: env["APP_URL"] ?? null, leadName: lead.name, interest: lead.interest, agent: agent ? { name: agent.name, email: agent.email } : null, matches });
    const port = await getEmailPort(db, env, "lead_followup");
    const sent = port.configured && (await port.send({ to: lead.email, ...mail })).status === "sent";
    return sent ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Stores one lead (idempotent on the provider's lead id), assigns it to the source's default agent, and sends the one-off follow-up email
 * if the source has it on. A retried webhook returns created:false and sends nothing. Never throws on a follow-up failure.
 */
export async function ingestLead(db: Queryable, source: LeadSource, lead: LeadInput, now: string, env: Env = process.env): Promise<IngestResult> {
  const r = await db.query(
    `INSERT INTO lead (source_id, external_id, name, email, phone, interest, suburb, postcode, campaign_ref, ad_ref, is_test, assigned_agent_id, assigned_at, received_at, updated_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $12::uuid IS NULL THEN NULL ELSE $13::timestamptz END,$13::timestamptz,$13::timestamptz)
     ON CONFLICT (source_id, external_id) DO NOTHING RETURNING id`,
    [source.id, lead.externalId, lead.name, lead.email, lead.phone, lead.interest, lead.suburb, lead.postcode, lead.campaignRef, lead.adRef, lead.isTest, source.defaultAgentId, now]);
  const row = r.rows[0];
  if (!row) {
    const ex = await db.query("SELECT id FROM lead WHERE source_id = $1::uuid AND external_id = $2", [source.id, lead.externalId]);
    return { created: false, leadId: String(ex.rows[0]!["id"]), followup: "none" };
  }
  const leadId = String(row["id"]);
  await audit(db, null, leadId, "lead.received", { source: source.id, provider: source.provider, test: lead.isTest }, now);
  const followup = await sendFollowup(db, source, leadId, lead, env);
  if (followup !== "skipped" || source.followupMode !== "off") {
    await db.query("UPDATE lead SET followup_status = $2, followup_sent_at = CASE WHEN $2 = 'sent' THEN $3::timestamptz END WHERE id = $1::uuid", [leadId, followup, now]);
  }
  if (!lead.isTest && source.defaultAgentId) void tellAgent(db, source.defaultAgentId, lead, env);
  return { created: true, leadId, followup };
}

async function tellAgent(db: Queryable, agentId: string, lead: LeadInput, env: Env): Promise<void> {
  const a = await activeAgent(db, agentId).catch(() => null);
  if (!a?.email) return;
  const base = env["APP_URL"]?.replace(/\/+$/, "");
  await sendNotice(db, "lead_assigned", a.email, {
    subject: "New lead assigned to you",
    text: `A new ${lead.interest ?? "property"} lead${lead.name ? ` from ${lead.name}` : ""} has been assigned to you.\n\nContact them as soon as you can; leads cool quickly.${base ? `\n\n${base}/staff/leads` : ""}`
  }, env);
}

// ---- Inbox ----

export interface LeadRow {
  id: string; sourceId: string; sourceLabel: string; provider: LeadProvider; name: string | null; email: string | null; phone: string | null;
  interest: LeadInterest | null; suburb: string | null; postcode: string | null; campaign: string | null; ad: string | null; isTest: boolean;
  status: LeadStatus; lostReason: string | null; assignedAgentId: string | null; assignedAgentName: string | null; followupStatus: string;
  enquired: boolean; offered: boolean; stage: string; receivedAt: string;
}
export interface LeadFilter { status?: LeadStatus | "unassigned" | "enquiry" | "offer"; sourceId?: string; agentId?: string; limit?: number; offset?: number }

// An enquiry or offer from an account with the lead's email, made after the lead arrived. Derived on read, never stored.
const ENQUIRED = `EXISTS (SELECT 1 FROM enquiry e JOIN app_user u ON u.id = e.buyer_user_id WHERE u.email = l.email AND e.created_at >= l.received_at)`;
const OFFERED = `EXISTS (SELECT 1 FROM formal_offer o JOIN app_user u ON u.id = o.buyer_user_id WHERE u.email = l.email AND o.submitted_at >= l.received_at)`;

export async function listLeads(db: Queryable, f: LeadFilter = {}): Promise<{ leads: LeadRow[]; total: number }> {
  const where: string[] = [], params: unknown[] = [];
  const add = (sql: (p: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  if (f.status === "unassigned") where.push("l.assigned_agent_id IS NULL");
  else if (f.status === "enquiry") where.push(ENQUIRED);
  else if (f.status === "offer") where.push(OFFERED);
  else if (f.status) add(p => `l.status = ${p}`, f.status);
  if (f.sourceId) add(p => `l.source_id = ${p}::uuid`, f.sourceId);
  if (f.agentId) add(p => `l.assigned_agent_id = ${p}::uuid`, f.agentId);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await db.query(`SELECT count(*) AS n FROM lead l ${w}`, params)).rows[0]!["n"]);
  params.push(Math.min(Math.max(f.limit ?? 50, 1), 100), Math.max(f.offset ?? 0, 0));
  const r = await db.query(
    `SELECT l.*, s.label AS source_label, s.provider, a.display_name AS agent_name, ${ENQUIRED} AS enquired, ${OFFERED} AS offered
       FROM lead l JOIN lead_source s ON s.id = l.source_id LEFT JOIN app_user a ON a.id = l.assigned_agent_id ${w}
      ORDER BY l.received_at DESC, l.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const leads = r.rows.map((x): LeadRow => {
    const status = x["status"] as LeadStatus, enquired = x["enquired"] === true, offered = x["offered"] === true;
    return {
      id: String(x["id"]), sourceId: String(x["source_id"]), sourceLabel: String(x["source_label"]), provider: x["provider"] as LeadProvider,
      name: x["name"] ? String(x["name"]) : null, email: x["email"] ? String(x["email"]) : null, phone: x["phone"] ? String(x["phone"]) : null,
      interest: (x["interest"] as LeadInterest | null) ?? null, suburb: x["suburb"] ? String(x["suburb"]) : null, postcode: x["postcode"] ? String(x["postcode"]) : null,
      campaign: x["campaign_ref"] ? String(x["campaign_ref"]) : null, ad: x["ad_ref"] ? String(x["ad_ref"]) : null, isTest: x["is_test"] === true,
      status, lostReason: x["lost_reason"] ? String(x["lost_reason"]) : null, assignedAgentId: x["assigned_agent_id"] ? String(x["assigned_agent_id"]) : null,
      assignedAgentName: x["agent_name"] ? String(x["agent_name"]) : null, followupStatus: String(x["followup_status"]), enquired, offered,
      stage: leadStage({ status, enquired, offered }), receivedAt: iso(x["received_at"])!
    };
  });
  return { leads, total };
}

export async function assignLead(db: Queryable, staffId: string, leadId: string, agentId: string | null, now: string, env: Env = process.env): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return { ok: false, error: "Lead not found." };
  if (agentId && !(await activeAgent(db, agentId))) return { ok: false, error: "That agent is not an active agent account." };
  const r = await db.query(
    "UPDATE lead SET assigned_agent_id = $2::uuid, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE $3::timestamptz END, updated_at = $3::timestamptz WHERE id = $1::uuid RETURNING name, interest, is_test, (assigned_agent_id IS DISTINCT FROM $2::uuid) AS x",
    [leadId, agentId, now]);
  const x = r.rows[0];
  if (!x) return { ok: false, error: "Lead not found." };
  await audit(db, staffId, leadId, "lead.assigned", { agentId }, now);
  if (agentId && x["is_test"] !== true) void tellAgent(db, agentId, { name: x["name"] ? String(x["name"]) : null, interest: (x["interest"] as LeadInterest | null) ?? null } as LeadInput, env);
  return { ok: true };
}

export async function setLeadStatus(db: Queryable, staffId: string, leadId: string, status: LeadStatus, lostReason: string | null, now: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return { ok: false, error: "Lead not found." };
  if (status === "lost" && !lostReason) return { ok: false, error: "Say why the lead was lost." };
  const r = await db.query("UPDATE lead SET status = $2, lost_reason = $3, updated_at = $4::timestamptz WHERE id = $1::uuid RETURNING id", [leadId, status, status === "lost" ? lostReason : null, now]);
  if (!r.rows[0]) return { ok: false, error: "Lead not found." };
  await audit(db, staffId, leadId, "lead.status", { status }, now);
  return { ok: true };
}

// ---- Figures per source ----

export interface SourceReport extends LeadSource { figures: FiguresView }
/** Per-source figures over the last `days` days (0 = all time). Test leads are excluded; spend is the days recorded in the same window. */
export async function sourceReports(db: Queryable, days: number, nowIso: string): Promise<SourceReport[]> {
  const since = days > 0 ? new Date(Date.parse(nowIso) - days * 86_400_000).toISOString() : "1970-01-01T00:00:00Z";
  const r = await db.query(
    `SELECT ${SRC_COLS},
       (SELECT count(*) FROM lead l WHERE l.source_id = s.id AND NOT l.is_test AND l.received_at >= $1::timestamptz) AS leads,
       (SELECT count(*) FROM lead l WHERE l.source_id = s.id AND NOT l.is_test AND l.received_at >= $1::timestamptz AND l.status IN ('contacted','qualified')) AS contacted,
       (SELECT count(*) FROM lead l WHERE l.source_id = s.id AND NOT l.is_test AND l.received_at >= $1::timestamptz AND ${ENQUIRED}) AS enquired,
       (SELECT count(*) FROM lead l WHERE l.source_id = s.id AND NOT l.is_test AND l.received_at >= $1::timestamptz AND ${OFFERED}) AS offered,
       COALESCE((SELECT sum(spend_cents) FROM lead_spend sp WHERE sp.source_id = s.id AND sp.day >= $1::timestamptz::date), 0) AS spend
     ${SRC_FROM} ORDER BY s.created_at DESC LIMIT 200`, [since]);
  return r.rows.map(x => ({
    ...publicSource(toSource(x)),
    figures: figuresView({ leads: Number(x["leads"]), contacted: Number(x["contacted"]), enquired: Number(x["enquired"]), offered: Number(x["offered"]), spendCents: Number(x["spend"]) })
  }));
}
