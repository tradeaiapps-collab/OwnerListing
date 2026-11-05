import { parseDefinition, type DueReport, type Frequency, type OfferFact, type ReportDefinition, type ReportDeps, type RunSnapshot, type SavedReport } from "../domain/agent-reports";
import { leadsPg } from "./agent-workspace-db";
import { getDb } from "./context";
import { verifiedLicencesPg, type Queryable } from "./db";
import { sendNotice } from "./messaging";

// Constant SQL; ids and text only travel as bound parameters. Everything is scoped to listings the agent is actively appointed to.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function offerFactsPg(db: Queryable, agentId: string): Promise<OfferFact[]> {
  const r = await db.query(
    `SELECT l.id AS listing_id, l.title, o.status, o.price_cents, o.submitted_at
       FROM listing_agent_appointment a
       JOIN property_listing l ON l.id = a.listing_id
       JOIN formal_offer o ON o.listing_id = l.id
      WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL
      ORDER BY o.submitted_at DESC, o.id LIMIT 2000`,
    [agentId]
  );
  return r.rows.map((x): OfferFact => ({ listingId: String(x["listing_id"]), listingTitle: String(x["title"]), status: String(x["status"]), priceCents: Number(x["price_cents"]), submittedAt: iso(x["submitted_at"]) }));
}

const defOf = (v: unknown): ReportDefinition | undefined => {
  const p = parseDefinition(v);
  return p.ok ? p.value : undefined;
};

const SELECT_REPORT = `SELECT r.id, r.name, r.definition, r.created_at, s.frequency, s.next_run_at, s.last_run_at, s.last_status
                         FROM agent_report r LEFT JOIN agent_report_schedule s ON s.report_id = r.id`;

function toSaved(x: Record<string, unknown>): SavedReport | undefined {
  const definition = defOf(x["definition"]);
  if (!definition) return undefined;
  return {
    id: String(x["id"]), name: String(x["name"]), definition, createdAt: iso(x["created_at"]),
    ...(x["frequency"] ? { schedule: { frequency: String(x["frequency"]) as Frequency, nextRunAt: iso(x["next_run_at"]), ...(x["last_run_at"] ? { lastRunAt: iso(x["last_run_at"]) } : {}), ...(x["last_status"] ? { lastStatus: String(x["last_status"]) } : {}) } } : {})
  };
}

export function createReportDeps(db: Queryable, now: () => Date = () => new Date(), env: Record<string, string | undefined> = process.env): ReportDeps {
  return {
    licences: () => verifiedLicencesPg(db), today: () => now().toISOString().slice(0, 10), now,
    async facts(agentId) { return { leads: await leadsPg(db, agentId), offers: await offerFactsPg(db, agentId) }; },
    async list(agentId) {
      const r = await db.query(`${SELECT_REPORT} WHERE r.agent_user_id = $1::uuid ORDER BY r.created_at DESC, r.id LIMIT 50`, [agentId]);
      return r.rows.map(toSaved).filter((x): x is SavedReport => !!x);
    },
    async get(agentId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
      const r = await db.query(`${SELECT_REPORT} WHERE r.id = $1::uuid AND r.agent_user_id = $2::uuid`, [id, agentId]);
      return r.rows[0] ? toSaved(r.rows[0]) : undefined;
    },
    async create(agentId, name, def) {
      const r = await db.query("INSERT INTO agent_report (agent_user_id, name, definition) VALUES ($1::uuid,$2,$3::jsonb) RETURNING id", [agentId, name, JSON.stringify(def)]);
      return String(r.rows[0]!["id"]);
    },
    async update(agentId, id, name, def) {
      await db.query("UPDATE agent_report SET name = $3, definition = $4::jsonb, updated_at = now() WHERE id = $1::uuid AND agent_user_id = $2::uuid", [id, agentId, name, JSON.stringify(def)]);
    },
    async remove(agentId, id) { await db.query("DELETE FROM agent_report WHERE id = $1::uuid AND agent_user_id = $2::uuid", [id, agentId]); },
    async setSchedule(id, frequency, next) {
      if (!frequency) { await db.query("DELETE FROM agent_report_schedule WHERE report_id = $1::uuid", [id]); return; }
      await db.query(
        `INSERT INTO agent_report_schedule (report_id, frequency, next_run_at) VALUES ($1::uuid,$2,$3::timestamptz)
         ON CONFLICT (report_id) DO UPDATE SET frequency = EXCLUDED.frequency, next_run_at = EXCLUDED.next_run_at, updated_at = now()`, [id, frequency, next]);
    },
    async addRun(id, trigger, from, to, totals, at) {
      await db.query("INSERT INTO agent_report_run (report_id, trigger, period_from, period_to, totals, created_at) VALUES ($1::uuid,$2,$3::date,$4::date,$5::jsonb,$6::timestamptz)", [id, trigger, from, to, JSON.stringify(totals), at]);
    },
    async runs(id) {
      const r = await db.query("SELECT id, trigger, to_char(period_from,'YYYY-MM-DD') AS f, to_char(period_to,'YYYY-MM-DD') AS t, totals, created_at FROM agent_report_run WHERE report_id = $1::uuid ORDER BY created_at DESC, id LIMIT 24", [id]);
      return r.rows.map((x): RunSnapshot => ({ id: String(x["id"]), trigger: String(x["trigger"]) as RunSnapshot["trigger"], periodFrom: String(x["f"]), periodTo: String(x["t"]), totals: (x["totals"] ?? {}) as RunSnapshot["totals"], createdAt: iso(x["created_at"]) }));
    },
    async due(at, limit) {
      const r = await db.query(
        `SELECT r.id, r.agent_user_id, r.name, r.definition, s.frequency, s.next_run_at, u.email
           FROM agent_report_schedule s JOIN agent_report r ON r.id = s.report_id JOIN app_user u ON u.id = r.agent_user_id
          WHERE s.next_run_at <= $1::timestamptz ORDER BY s.next_run_at, r.id LIMIT $2`, [at, limit]);
      return r.rows.flatMap((x): DueReport[] => {
        const definition = defOf(x["definition"]);
        return definition ? [{ reportId: String(x["id"]), agentId: String(x["agent_user_id"]), name: String(x["name"]), definition, frequency: String(x["frequency"]) as Frequency, nextRunAt: iso(x["next_run_at"]), ...(x["email"] ? { email: String(x["email"]) } : {}) }] : [];
      });
    },
    async claim(reportId, now, next) {
      const r = await db.query("UPDATE agent_report_schedule SET next_run_at = $3::timestamptz WHERE report_id = $1::uuid AND next_run_at <= $2::timestamptz RETURNING report_id", [reportId, now, next]);
      return r.rows.length === 1;
    },
    async finish(reportId, status, at) { await db.query("UPDATE agent_report_schedule SET last_status = $2, last_run_at = $3::timestamptz WHERE report_id = $1::uuid", [reportId, status, at]); },
    send: (_agentId, to, subject, text) => sendNotice(db, "agent_report", to, { subject, text }, env)
  };
}
export const getReportDeps = (): ReportDeps => createReportDeps(getDb());
