import { createHash, randomUUID } from "node:crypto";
import type { AgentCandidate } from "../domain/agent-matching";
import type { AgentLeadStats } from "../domain/lead-routing";
import { DEFAULT_CONFIG, type LeadSlots, type LeadState, type QualifierConfig, type ScoreWeights, type SlotKey, type Tier } from "../domain/lead-qualifier";
import type { LabelledLead } from "../domain/lead-learning";
import type { LeadRecord, LeadRepository, LeadNote, LeadTurn, Assignment, FollowUpRow } from "../domain/lead-service";
import { getAiEngine } from "./ai";
import { getDb } from "./context";
import { appendAuditPg, verifiedLicencesPg, type Queryable } from "./db";
import { sendNotice, getSmsPort } from "./messaging";

// Constant SQL text; every value is a bound parameter. Contact details live inside the lead's slots and are only returned to the assigned agent's routes.

const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const obj = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : ((v as T) ?? fallback));

const LEAD_COLS =
  "l.id, l.channel, l.external_id, l.slots, l.asked, l.skipped, l.last_asked, l.turns, l.status, l.score, l.tier, l.score_detail, l.config_version, " +
  "l.consent_contact, l.routed_at, l.checkins_sent, l.created_at, l.updated_at, " +
  "a.agent_user_id, a.assigned_at, a.assigned_by, a.agent_score, a.reasons, a.alternatives, a.sla_due_at, a.first_contact_at, a.result, a.result_at, a.result_note";
const LEAD_FROM = " FROM lead l LEFT JOIN lead_assignment a ON a.lead_id = l.id";

function toLead(r: Record<string, unknown>): LeadRecord {
  const slots = obj<LeadSlots>(r["slots"], {});
  const state: LeadState = {
    slots, asked: obj(r["asked"], {}), skipped: obj<SlotKey[]>(r["skipped"], []), turns: Number(r["turns"]), status: r["status"] as LeadState["status"],
    ...(r["last_asked"] ? { lastAsked: r["last_asked"] as SlotKey } : {})
  };
  const detail = obj<{ factors?: unknown; missing?: unknown }>(r["score_detail"], {});
  const score = { score: Number(r["score"]), tier: r["tier"] as Tier, factors: (detail.factors ?? []) as never, missing: (detail.missing ?? []) as never };
  const assignment: Assignment | undefined = r["agent_user_id"] ? {
    agentUserId: String(r["agent_user_id"]), assignedAt: iso(r["assigned_at"]), assignedBy: r["assigned_by"] as "elena" | "staff", agentScore: Number(r["agent_score"]),
    reasons: obj(r["reasons"], []), alternatives: obj(r["alternatives"], []), slaDueAt: iso(r["sla_due_at"]),
    firstContactAt: r["first_contact_at"] ? iso(r["first_contact_at"]) : undefined, result: (r["result"] as Assignment["result"]) ?? undefined,
    resultAt: r["result_at"] ? iso(r["result_at"]) : undefined, resultNote: r["result_note"] ? String(r["result_note"]) : undefined
  } : undefined;
  return {
    id: String(r["id"]), channel: r["channel"] as LeadRecord["channel"], externalId: String(r["external_id"]), state, score, configVersion: Number(r["config_version"]),
    consentContact: r["consent_contact"] === true, routedAt: r["routed_at"] ? iso(r["routed_at"]) : undefined, checkinsSent: Number(r["checkins_sent"]),
    createdAt: iso(r["created_at"]), updatedAt: iso(r["updated_at"]), assignment
  };
}

const UPSERT_LEAD =
  "INSERT INTO lead (id, channel, external_id, slots, asked, skipped, last_asked, turns, status, score, tier, score_detail, config_version, consent_contact, origin_hash, routed_at, checkins_sent, created_at, updated_at) " +
  "VALUES ($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::timestamptz,$17,$18::timestamptz,$19::timestamptz) " +
  "ON CONFLICT (id) DO UPDATE SET slots = EXCLUDED.slots, asked = EXCLUDED.asked, skipped = EXCLUDED.skipped, last_asked = EXCLUDED.last_asked, turns = EXCLUDED.turns, " +
  "status = EXCLUDED.status, score = EXCLUDED.score, tier = EXCLUDED.tier, score_detail = EXCLUDED.score_detail, config_version = EXCLUDED.config_version, " +
  "consent_contact = EXCLUDED.consent_contact, routed_at = EXCLUDED.routed_at, checkins_sent = EXCLUDED.checkins_sent, updated_at = EXCLUDED.updated_at, " +
  "abandoned_after = CASE WHEN EXCLUDED.status = 'abandoned' THEN EXCLUDED.last_asked ELSE lead.abandoned_after END";

const toWeights = (v: unknown): ScoreWeights => ({ ...DEFAULT_CONFIG.weights, ...obj<Partial<ScoreWeights>>(v, {}) });

export function createPgLeadRepository(db: Queryable): LeadRepository {
  return {
    async findLatest(channel, externalId) {
      const r = (await db.query(`SELECT ${LEAD_COLS}${LEAD_FROM} WHERE l.channel = $1 AND l.external_id = $2 ORDER BY l.created_at DESC LIMIT 1`, [channel, externalId])).rows[0];
      return r ? toLead(r) : undefined;
    },
    async get(id) {
      const r = (await db.query(`SELECT ${LEAD_COLS}${LEAD_FROM} WHERE l.id = $1::uuid`, [id])).rows[0];
      return r ? toLead(r) : undefined;
    },
    async countCreatedByOrigin(originHash, since) {
      const r = await db.query("SELECT count(*)::int AS n FROM lead WHERE origin_hash = $1 AND created_at >= $2::timestamptz", [originHash, since]);
      return Number(r.rows[0]?.["n"] ?? 0);
    },
    async save(l, extra) {
      await atomic(db, async tx => {
        await tx.query(UPSERT_LEAD, [
          l.id, l.channel, l.externalId, JSON.stringify(l.state.slots), JSON.stringify(l.state.asked), JSON.stringify(l.state.skipped), l.state.lastAsked ?? null, l.state.turns,
          l.state.status, l.score.score, l.score.tier, JSON.stringify({ factors: l.score.factors, missing: l.score.missing }), l.configVersion, l.consentContact,
          extra.originHash ?? null, l.routedAt ?? null, l.checkinsSent, l.createdAt, l.updatedAt]);
        for (const t of extra.turns ?? []) await tx.query("INSERT INTO lead_turn (id, lead_id, direction, body, created_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz)", [randomUUID(), l.id, t.direction, t.body.slice(0, 1000), t.createdAt]);
        for (const n of extra.notes ?? []) await tx.query("INSERT INTO lead_note (id, lead_id, author_type, author_user_id, body, created_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz)", [n.id, l.id, n.authorType, n.authorUserId ?? null, n.body.slice(0, 2000), n.createdAt]);
        for (const f of extra.followUps ?? []) await tx.query("INSERT INTO lead_followup (id, lead_id, kind, attempt, due_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz)", [f.id, l.id, f.plan.kind, f.plan.attempt, f.plan.dueAt]);
        if (extra.audit) await appendAuditPg(tx, extra.audit);
      });
    },
    async assign(leadId, a, ev) {
      await atomic(db, async tx => {
        await tx.query(
          "INSERT INTO lead_assignment (lead_id, agent_user_id, assigned_at, assigned_by, agent_score, reasons, alternatives, sla_due_at) VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4,$5,$6::jsonb,$7::jsonb,$8::timestamptz) " +
          "ON CONFLICT (lead_id) DO UPDATE SET agent_user_id = EXCLUDED.agent_user_id, assigned_at = EXCLUDED.assigned_at, assigned_by = EXCLUDED.assigned_by, agent_score = EXCLUDED.agent_score, " +
          "reasons = EXCLUDED.reasons, alternatives = EXCLUDED.alternatives, sla_due_at = EXCLUDED.sla_due_at, first_contact_at = NULL " +
          "WHERE lead_assignment.result IS NULL",
          [leadId, a.agentUserId, a.assignedAt, a.assignedBy, a.agentScore, JSON.stringify(a.reasons), JSON.stringify(a.alternatives), a.slaDueAt]);
        await appendAuditPg(tx, ev);
      });
    },
    async setFirstContact(id, at) { await db.query("UPDATE lead_assignment SET first_contact_at = $2::timestamptz WHERE lead_id = $1::uuid AND first_contact_at IS NULL", [id, at]); },
    async setResult(id, result, note, at, ev) {
      await atomic(db, async tx => {
        await tx.query("UPDATE lead_assignment SET result = $2, result_at = $3::timestamptz, result_note = $4 WHERE lead_id = $1::uuid AND result IS NULL", [id, result, at, note ?? null]);
        await appendAuditPg(tx, ev);
      });
    },
    async addNote(id, n) {
      const r = await db.query(
        "INSERT INTO lead_note (id, lead_id, author_type, author_user_id, body, created_at) SELECT $1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz WHERE (SELECT count(*) FROM lead_note WHERE lead_id = $2::uuid) < 50 RETURNING id",
        [n.id, id, n.authorType, n.authorUserId ?? null, n.body, n.createdAt]);
      return r.rows.length > 0;
    },
    async notes(id) {
      const { rows } = await db.query("SELECT id, author_type, author_user_id, body, created_at FROM lead_note WHERE lead_id = $1::uuid ORDER BY created_at LIMIT 100", [id]);
      return rows.map((r): LeadNote => ({ id: String(r["id"]), authorType: r["author_type"] as LeadNote["authorType"], authorUserId: r["author_user_id"] ? String(r["author_user_id"]) : undefined, body: String(r["body"]), createdAt: iso(r["created_at"]) }));
    },
    async turns(id) {
      const { rows } = await db.query("SELECT direction, body, created_at FROM lead_turn WHERE lead_id = $1::uuid ORDER BY created_at, id LIMIT 200", [id]);
      return rows.map((r): LeadTurn => ({ direction: r["direction"] as "in" | "out", body: String(r["body"]), createdAt: iso(r["created_at"]) }));
    },
    async listForAgent(agent) {
      const { rows } = await db.query(`SELECT ${LEAD_COLS}${LEAD_FROM} WHERE a.agent_user_id = $1::uuid ORDER BY (a.result IS NULL) DESC, l.updated_at DESC LIMIT 200`, [agent]);
      return rows.map(toLead);
    },
    async listUnrouted(limit) {
      const { rows } = await db.query(`SELECT ${LEAD_COLS}${LEAD_FROM} WHERE a.lead_id IS NULL AND l.status IN ('complete','handoff_requested') ORDER BY l.updated_at DESC LIMIT $1`, [limit]);
      return rows.map(toLead);
    },
    async activeConfig() {
      const r = (await db.query("SELECT version, weights, question_order, sample_size FROM lead_qualifier_config WHERE activated_at IS NOT NULL ORDER BY version DESC LIMIT 1")).rows[0];
      return r ? { version: Number(r["version"]), weights: toWeights(r["weights"]), questionOrder: obj<SlotKey[]>(r["question_order"], [...DEFAULT_CONFIG.questionOrder]), sampleSize: Number(r["sample_size"]) } : DEFAULT_CONFIG;
    },
    async saveConfig(c: QualifierConfig, by, ev) {
      await atomic(db, async tx => {
        await tx.query("INSERT INTO lead_qualifier_config (version, weights, question_order, sample_size, created_by) VALUES ($1,$2::jsonb,$3::jsonb,$4,$5::uuid) ON CONFLICT (version) DO NOTHING",
          [c.version, JSON.stringify(c.weights), JSON.stringify(c.questionOrder), c.sampleSize, by]);
        await appendAuditPg(tx, ev);
      });
    },
    async activateConfig(version, by, at, ev) {
      return atomic(db, async tx => {
        const r = await tx.query("UPDATE lead_qualifier_config SET activated_at = $2::timestamptz, activated_by = $3::uuid WHERE version = $1 RETURNING version", [version, at, by]);
        if (r.rows.length === 0) return false;
        await appendAuditPg(tx, ev);
        return true;
      });
    },
    async labelled() {
      const { rows } = await db.query(
        "SELECT l.slots, l.asked, l.status, l.abandoned_after, a.result FROM lead l LEFT JOIN lead_assignment a ON a.lead_id = l.id " +
        "WHERE a.result IS NOT NULL OR l.status = 'abandoned' ORDER BY l.created_at DESC LIMIT 5000");
      return rows.map((r): LabelledLead => ({
        slots: obj<LeadSlots>(r["slots"], {}), asked: obj(r["asked"], {}), result: (r["result"] as LabelledLead["result"]) ?? "unresponsive",
        abandonedAfter: (r["abandoned_after"] as SlotKey | null) ?? undefined, abandoned: r["result"] === null
      }));
    },
    async candidates(jurisdiction) {
      const { rows } = await db.query(
        "SELECT u.id, u.display_name, p.accepting_new, p.max_active_listings, p.service_postcodes, p.service_suburbs, p.transaction_types, p.use_classes, p.property_types, p.bio " +
        "FROM agent_profile p JOIN app_user u ON u.id = p.user_id WHERE u.user_type = 'agent' AND u.status = 'active' AND p.accepting_new " +
        "AND EXISTS (SELECT 1 FROM agent_licence x WHERE x.user_id = u.id AND x.jurisdiction = $1::text AND x.status = 'verified') ORDER BY u.id LIMIT 2000", [jurisdiction]);
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
      return rows.map((r): AgentCandidate => ({
        userId: String(r["id"]), displayName: String(r["display_name"]), activeListings: 0,
        profile: { acceptingNew: true, maxActiveListings: Number(r["max_active_listings"]), servicePostcodes: list(r["service_postcodes"]), serviceSuburbs: list(r["service_suburbs"]),
          transactionTypes: list(r["transaction_types"]), useClasses: list(r["use_classes"]), propertyTypes: list(r["property_types"]), bio: String(r["bio"] ?? "") }
      }));
    },
    verifiedLicences: () => verifiedLicencesPg(db),
    async agentStats() {
      const { rows } = await db.query(
        "SELECT agent_user_id, count(*) FILTER (WHERE result IS NULL)::int AS open, count(*)::int AS routed, count(*) FILTER (WHERE result = 'converted')::int AS converted " +
        "FROM lead_assignment GROUP BY agent_user_id");
      return rows.map((r): AgentLeadStats => ({ agentUserId: String(r["agent_user_id"]), openLeads: Number(r["open"]), routed: Number(r["routed"]), converted: Number(r["converted"]) }));
    },
    async dueFollowUps(now, limit) {
      const { rows } = await db.query("SELECT id, lead_id, kind, attempt, due_at FROM lead_followup WHERE status = 'pending' AND due_at <= $1::timestamptz ORDER BY due_at LIMIT $2", [now, limit]);
      return rows.map((r): FollowUpRow => ({ id: String(r["id"]), leadId: String(r["lead_id"]), kind: r["kind"] as FollowUpRow["kind"], attempt: Number(r["attempt"]), dueAt: iso(r["due_at"]) }));
    },
    async markFollowUp(id, status, at) { await db.query("UPDATE lead_followup SET status = $2, handled_at = $3::timestamptz WHERE id = $1::uuid", [id, status, at]); },
    async abandonIdle(now, hours) {
      const { rows } = await db.query(
        `UPDATE lead SET status = 'abandoned', abandoned_after = last_asked WHERE status = 'open' AND updated_at <= $1::timestamptz - make_interval(hours => $2) RETURNING id`, [now, hours]);
      const out: LeadRecord[] = [];
      for (const r of rows) { const l = await this.get(String(r["id"])); if (l) out.push(l); }
      return out;
    }
  };
}

/** Deletes the text of finished conversations after `days` (notes and results stay). Called by the follow-up tick. */
export async function purgeOldLeadText(db: Queryable, days = 180): Promise<number> {
  const r = await db.query(
    "DELETE FROM lead_turn t USING lead l WHERE t.lead_id = l.id AND l.status <> 'open' AND l.updated_at < now() - make_interval(days => $1) RETURNING t.id", [days]);
  return r.rows.length;
}

export const originHashOf = (ip: string | null): string | undefined =>
  ip ? createHash("sha256").update(`lead-origin:${ip}`).digest("hex").slice(0, 32) : undefined;

export async function getLeadDeps(db: Queryable = getDb()) {
  return { repo: createPgLeadRepository(db), engine: await getAiEngine(), now: () => new Date().toISOString(), newId: () => randomUUID() };
}

/** Sends Elena's check-ins through the logged messaging ports. */
export function createFollowUpSender(db: Queryable, env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    async send(channel: "sms" | "email", to: string, text: string): Promise<boolean> {
      try {
        if (channel === "email") return await sendNotice(db, "lead_checkin", to, { subject: "Following up on your property search", text });
        const port = await getSmsPort(db, env, "lead_checkin");
        return port.configured && (await port.sendText(to, text, {})).status === "sent";
      } catch { return false; }
    }
  };
}

