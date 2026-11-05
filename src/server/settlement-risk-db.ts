import { type MilestoneStatus, type Stage } from "../domain/settlement";
import { assessRisk, historyReason, RULES_VERSION, trendOf, type Band, type RiskAssessment, type RiskInput } from "../domain/settlement-risk";
import { localDay } from "../domain/sale-fall-through";
import type { Queryable } from "./db";
import { settlementView, type Out } from "./settlement-db";

// Parameterised SQL only. Scores are worked out from the facts below every time; settlement_risks only remembers the last score for trends.
const DAY = 86_400_000;
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const day = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const wholeDays = (from: unknown, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso(from) ?? now.toISOString()).getTime()) / DAY));
// Constant SQL fragments (no user input). Staff see every inspection finding that belongs to the buyer's deal. The owner and agent only see
// findings from inspections that were shared with them (or that the owner requested): the buyer's private report and cancelled bookings stay private.
const STAFF_INSPECTIONS = "(i.requested_by = t.buyer_id OR EXISTS (SELECT 1 FROM inspection_share s WHERE s.inspection_id = i.id AND s.shared_with_user_id = t.buyer_id AND s.revoked_at IS NULL))";
const PARTY_INSPECTIONS = `(i.requested_by = t.seller_id OR EXISTS (SELECT 1 FROM inspection_share s WHERE s.inspection_id = i.id AND s.revoked_at IS NULL
  AND (s.shared_with_user_id = t.seller_id OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = t.listing_id AND a.agent_user_id = s.shared_with_user_id AND a.revoked_at IS NULL))))`;
const LIVE_OFFERS = "('submitted','under_review','countered','buyer_countered')";

interface Loaded { id: string; listingTitle: string; state: string; stage: Stage; input: RiskInput }

/** The facts for each settlement id (or every open settlement), as risk inputs. Closed sales are skipped. */
async function load(db: Queryable, ids: string[] | null, now: Date, view: "staff" | "party" = "staff"): Promise<Loaded[]> {
  const scope = view === "party" ? PARTY_INSPECTIONS : STAFF_INSPECTIONS;
  const rows = (await db.query(
    `SELECT t.id, t.state, t.current_stage, t.stage_entered_at, l.title, l.price_cents AS asking_cents, o.price_cents AS offer_cents,
            (SELECT m.status FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.stage = t.current_stage) AS current_status,
            (SELECT m.actual_date FROM settlement_milestones m WHERE m.settlement_id = t.id AND m.stage = 'offer_accepted') AS accepted_on,
            (SELECT count(*) FROM formal_offer x WHERE x.listing_id = t.listing_id AND x.id <> t.offer_id AND x.buyer_user_id <> t.buyer_id AND x.status IN ${LIVE_OFFERS}) AS competing,
            (SELECT (SELECT count(*) FROM inspection_booking b WHERE b.listing_id = t.listing_id AND b.buyer_id = t.buyer_id AND b.status = 'cancelled')
                  + (SELECT count(*) FROM inspection i WHERE i.listing_id = t.listing_id AND i.requested_by = t.buyer_id AND i.status = 'cancelled')) AS reschedules,
            (SELECT count(*) FROM inspection_finding f JOIN inspection i ON i.id = f.inspection_id
              WHERE i.listing_id = t.listing_id AND i.status = 'completed' AND f.severity IN ('major','critical') AND f.followup_status NOT IN ('resolved','wont_fix')
                AND ${scope}) AS major_open,
            (SELECT min(f.created_at) FROM inspection_finding f JOIN inspection i ON i.id = f.inspection_id
              WHERE i.listing_id = t.listing_id AND i.status = 'completed' AND f.severity IN ('major','critical') AND f.followup_status NOT IN ('resolved','wont_fix')
                AND ${scope}) AS major_since,
            (SELECT c.status FROM sale_fall_through c WHERE c.offer_id = t.offer_id AND c.status IN ('proposed','disputed') ORDER BY c.created_at DESC LIMIT 1) AS open_case
       FROM settlement_timeline t JOIN property_listing l ON l.id = t.listing_id JOIN formal_offer o ON o.id = t.offer_id
      WHERE t.completed_at IS NULL AND o.status <> 'fallen_through' AND ($1::uuid[] IS NULL OR t.id = ANY($1::uuid[]))
      ORDER BY t.stage_entered_at, t.id LIMIT 1000`, [ids])).rows;
  if (!rows.length) return [];
  const found = rows.map(r => String(r["id"]));
  const ms = (await db.query("SELECT settlement_id, stage, status, target_date, actual_date FROM settlement_milestones WHERE settlement_id = ANY($1::uuid[])", [found])).rows;
  const checks = (await db.query(
    "SELECT settlement_id, milestone_stage, role, items FROM settlement_checklists WHERE settlement_id = ANY($1::uuid[]) AND ((milestone_stage = 'offer_accepted' AND role = 'buyer') OR (milestone_stage = 'cooling_off_expires' AND role = 'agent'))", [found])).rows;
  return rows.map(r => {
    const id = String(r["id"]), state = String(r["state"]), stage = String(r["current_stage"]) as Stage;
    const done = (st: string, role: string) => { const c = checks.find(x => String(x["settlement_id"]) === id && x["milestone_stage"] === st && x["role"] === role); const items = (c?.["items"] ?? []) as { done: boolean }[]; return items.length > 0 && items.every(i => i.done); };
    const accepted = day(r["accepted_on"]);
    const today = localDay(now, state);
    const input: RiskInput = {
      today, currentStage: stage, daysInStage: wholeDays(r["stage_entered_at"], now), stageBlocked: r["current_status"] === "blocked",
      milestones: ms.filter(m => String(m["settlement_id"]) === id).map(m => ({ stage: String(m["stage"]) as Stage, status: String(m["status"]) as MilestoneStatus, targetDate: day(m["target_date"]), actualDate: day(m["actual_date"]) })),
      daysSinceAccepted: accepted ? Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${accepted}T00:00:00Z`)) / DAY)) : 0,
      financeNeedsConfirmed: done("offer_accepted", "buyer"), buyerInterestConfirmed: done("cooling_off_expires", "agent"),
      openMajorFindings: Number(r["major_open"]), oldestMajorFindingDays: r["major_since"] ? wholeDays(r["major_since"], now) : 0,
      inspectionReschedules: view === "party" ? 0 : Number(r["reschedules"]), competingOffers: Number(r["competing"]),
      soldBelowAsking: r["asking_cents"] != null && Number(r["offer_cents"]) < Number(r["asking_cents"]),
      openCase: r["open_case"] === "disputed" ? "disputed" : r["open_case"] === "proposed" ? "proposed" : "none"
    };
    return { id, listingTitle: String(r["title"]), state, stage, input };
  });
}

// ---------- refresh ----------

/** Keeps the history of sales that fell through: when, why and how risky they looked at the end. Safe to repeat. */
async function recordFallthroughs(tx: Queryable) {
  const rows = (await tx.query(
    `SELECT t.id, t.current_stage, r.risk_score,
            (SELECT max(e.occurred_at) FROM offer_event e WHERE e.offer_id = o.id AND e.event_type = 'fallen_through') AS fell_at,
            (SELECT c.reason FROM sale_fall_through c WHERE c.offer_id = o.id AND c.status <> 'withdrawn' ORDER BY c.created_at DESC LIMIT 1) AS reason
       FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id LEFT JOIN settlement_risks r ON r.settlement_id = t.id
      WHERE o.status = 'fallen_through' AND NOT EXISTS (SELECT 1 FROM fallthrough_history h WHERE h.settlement_id = t.id) LIMIT 500`, [])).rows;
  for (const r of rows) {
    await tx.query(
      "INSERT INTO fallthrough_history (settlement_id, fell_through_date, reason, stage_at_fall, final_score) VALUES ($1::uuid, COALESCE($2::timestamptz, now())::date, $3, $4, $5) ON CONFLICT (settlement_id) DO NOTHING",
      [r["id"], iso(r["fell_at"]), historyReason(r["reason"] ? String(r["reason"]) : null), r["current_stage"], r["risk_score"] ?? null]);
  }
}

/** Scores every open settlement and stores the result (so the next score can show the trend). Returns the assessments by id. */
export async function refreshRisks(db: Queryable, now: Date = new Date()): Promise<Map<string, RiskAssessment & { listingTitle: string; stage: Stage }>> {
  const out = new Map<string, RiskAssessment & { listingTitle: string; stage: Stage }>();
  await atomic(db, async tx => {
    // One writer at a time: a request that finds a refresh already running still returns live scores but writes nothing, so staff views never queue or deadlock on each other.
    const writer = Boolean((await tx.query("SELECT pg_try_advisory_xact_lock(hashtext('settlement_risk_refresh')) AS ok", [])).rows[0]?.["ok"]);
    const loaded = await load(tx, null, now);
    for (const s of loaded) {
      const a = assessRisk(s.input);
      out.set(s.id, { ...a, listingTitle: s.listingTitle, stage: s.stage });
      if (!writer) continue;
      // Rows whose score, band and reasons did not change are left alone (scored_at is when the score last changed).
      await tx.query(
        `INSERT INTO settlement_risks (settlement_id, risk_score, band, primary_risk_factor, secondary_risks, predicted_fallthrough_date, rules_version, scored_at, flagged_at)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, CASE WHEN $3 = 'high' THEN $8::timestamptz END)
         ON CONFLICT (settlement_id) DO UPDATE SET
           previous_score = CASE WHEN settlement_risks.risk_score <> EXCLUDED.risk_score THEN settlement_risks.risk_score ELSE settlement_risks.previous_score END,
           risk_score = EXCLUDED.risk_score, band = EXCLUDED.band, primary_risk_factor = EXCLUDED.primary_risk_factor, secondary_risks = EXCLUDED.secondary_risks,
           predicted_fallthrough_date = EXCLUDED.predicted_fallthrough_date, rules_version = EXCLUDED.rules_version, scored_at = EXCLUDED.scored_at,
           flagged_at = CASE WHEN EXCLUDED.band = 'high' AND settlement_risks.band <> 'high' THEN EXCLUDED.scored_at ELSE settlement_risks.flagged_at END,
           addressed_at = CASE WHEN EXCLUDED.band = 'high' THEN NULL WHEN settlement_risks.band = 'high' THEN EXCLUDED.scored_at ELSE settlement_risks.addressed_at END
         WHERE (settlement_risks.risk_score, settlement_risks.band, settlement_risks.primary_risk_factor, settlement_risks.secondary_risks, settlement_risks.predicted_fallthrough_date, settlement_risks.rules_version)
               IS DISTINCT FROM (EXCLUDED.risk_score, EXCLUDED.band, EXCLUDED.primary_risk_factor, EXCLUDED.secondary_risks, EXCLUDED.predicted_fallthrough_date, EXCLUDED.rules_version)`,
        [s.id, a.score, a.band, a.primary?.label ?? null, JSON.stringify(a.factors.filter(f => f !== a.primary).map(f => ({ key: f.key, label: f.label, points: f.points }))), a.predictedFallthroughDate, RULES_VERSION, now.toISOString()]);
    }
    if (!writer) return;
    // A sale that finished or fell through is no longer at risk: close any open high-risk flag.
    await tx.query(
      `UPDATE settlement_risks r SET addressed_at = $1 FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id
        WHERE t.id = r.settlement_id AND r.band = 'high' AND r.addressed_at IS NULL AND (t.completed_at IS NOT NULL OR o.status = 'fallen_through')`, [now.toISOString()]);
    await recordFallthroughs(tx);
  });
  return out;
}

// ---------- staff dashboard ----------

export interface RiskRow {
  id: string; listingTitle: string; stage: Stage; score: number; band: Band; trend: "worse" | "better" | "same"; change: number;
  primary: string | null; predictedFallthroughDate: string | null; flaggedAt: string | null;
}
export interface RiskDashboard {
  rows: RiskRow[]; alerts: RiskRow[];
  totals: { open: number; high: number; medium: number; low: number };
  history: { fellThrough: number; settled: number; ratePercent: number | null; byReason: Record<string, number> };
  rulesVersion: string;
}

/** Every open settlement ranked by risk, the top 10 at-risk deals, and the historical fall-through record. Re-scores on the way (staff-only, idempotent). */
export async function riskDashboard(db: Queryable, now: Date = new Date()): Promise<RiskDashboard> {
  const scored = await refreshRisks(db, now);
  const prev = new Map((await db.query("SELECT settlement_id, previous_score, flagged_at FROM settlement_risks", [])).rows.map(r => [String(r["settlement_id"]), r]));
  const rows: RiskRow[] = [...scored.entries()].map(([id, a]) => {
    const p = prev.get(id), before = p?.["previous_score"] == null ? null : Number(p["previous_score"]);
    return { id, listingTitle: a.listingTitle, stage: a.stage, score: a.score, band: a.band, trend: trendOf(a.score, before), change: before == null ? 0 : a.score - before,
      primary: a.primary?.label ?? null, predictedFallthroughDate: a.predictedFallthroughDate, flaggedAt: iso(p?.["flagged_at"]) };
  }).sort((a, b) => b.score - a.score || a.listingTitle.localeCompare(b.listingTitle));
  const hist = (await db.query("SELECT reason, count(*) AS n FROM fallthrough_history GROUP BY reason", [])).rows;
  const fellThrough = hist.reduce((s, r) => s + Number(r["n"]), 0);
  const settled = Number((await db.query("SELECT count(*) AS n FROM settlement_timeline WHERE completed_at IS NOT NULL", [])).rows[0]?.["n"] ?? 0);
  return {
    rows, alerts: rows.filter(r => r.band !== "low").slice(0, 10),
    totals: { open: rows.length, high: rows.filter(r => r.band === "high").length, medium: rows.filter(r => r.band === "medium").length, low: rows.filter(r => r.band === "low").length },
    history: { fellThrough, settled, ratePercent: fellThrough + settled > 0 ? Math.round((100 * fellThrough) / (fellThrough + settled)) : null, byReason: Object.fromEntries(hist.map(r => [String(r["reason"]), Number(r["n"])])) },
    rulesVersion: RULES_VERSION
  };
}

// ---------- one settlement ----------

export interface RiskDetail extends RiskAssessment { settlementId: string; listingTitle: string; stage: Stage; previousScore: number | null; trend: "worse" | "better" | "same"; flaggedAt: string | null }

async function detail(db: Queryable, id: string, now: Date, view: "staff" | "party"): Promise<Out<RiskDetail>> {
  const s = (await load(db, [id], now, view))[0];
  if (!s) return no(404, "No open settlement to score.");
  const a = assessRisk(s.input);
  const stored = (await db.query("SELECT previous_score, risk_score, flagged_at FROM settlement_risks WHERE settlement_id = $1::uuid", [id])).rows[0];
  // The stored score may be older than this live one; compare against what was last stored.
  const before = stored ? (Number(stored["risk_score"]) !== a.score ? Number(stored["risk_score"]) : stored["previous_score"] == null ? null : Number(stored["previous_score"])) : null;
  // The stored score is the staff view (it includes buyer-private facts), so the owner and agent get no trend or history derived from it.
  if (view === "party") return { ok: true, value: { ...a, settlementId: id, listingTitle: s.listingTitle, stage: s.stage, previousScore: null, trend: "same", flaggedAt: null } };
  return { ok: true, value: { ...a, settlementId: id, listingTitle: s.listingTitle, stage: s.stage, previousScore: before, trend: trendOf(a.score, before), flaggedAt: iso(stored?.["flagged_at"]) } };
}

/** Staff view of one settlement's risk (live score, no names). */
export const staffRiskDetail = (db: Queryable, id: string, now: Date = new Date()) => detail(db, id, now, "staff");

/** The owner's or appointed agent's view. The buyer never sees it: it is advice about their own deal. */
export async function partyRiskDetail(db: Queryable, userId: string, id: string, now: Date = new Date()): Promise<Out<RiskDetail>> {
  const v = await settlementView(db, userId, id, now);
  if (!v.ok) return v;
  if (v.value.side === "buyer") return no(403, "Risk advice is for the owner and their agent.");
  return detail(db, id, now, "party");
}

