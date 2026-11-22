import type { Analysis, HistoryProject, ProposalInput } from "../domain/feasibility";
import type { Queryable } from "./db";

// Parameterised SQL only. Both tables are insert only (db trigger).
export interface HistoryRow extends HistoryProject { id: string; createdAt: string }
export interface AnalysisRow { id: string; title: string; points: number; successProbability: number; createdAt: string; analysis: Analysis }

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function listHistoryPg(db: Queryable, limit = 200): Promise<HistoryRow[]> {
  const r = await db.query(`SELECT id, name, points, weeks, outcome, created_at FROM project_history ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows.map(x => ({ id: String(x["id"]), name: String(x["name"]), points: Number(x["points"]), weeks: Number(x["weeks"]), outcome: x["outcome"] === "failed" ? "failed" : "succeeded", createdAt: iso(x["created_at"]) }));
}

export async function addHistoryPg(db: Queryable, h: HistoryProject, staffId: string): Promise<string> {
  const r = await db.query(`INSERT INTO project_history (name, points, weeks, outcome, created_by) VALUES ($1, $2, $3, $4, $5::uuid) RETURNING id`, [h.name, h.points, h.weeks, h.outcome, staffId]);
  return String(r.rows[0]!["id"]);
}

export async function saveAnalysisPg(db: Queryable, input: ProposalInput, a: Analysis, staffId: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO feasibility_analysis (title, engine, input, result, points, success_probability, requested_by) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::uuid) RETURNING id`,
    [input.title, a.engine, JSON.stringify(input), JSON.stringify(a), a.points, a.successProbability, staffId]);
  return String(r.rows[0]!["id"]);
}

export async function recentAnalysesPg(db: Queryable, limit = 20): Promise<AnalysisRow[]> {
  const r = await db.query(`SELECT id, title, points, success_probability, created_at, result FROM feasibility_analysis ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows.map(x => ({ id: String(x["id"]), title: String(x["title"]), points: Number(x["points"]), successProbability: Number(x["success_probability"]), createdAt: iso(x["created_at"]), analysis: x["result"] as Analysis }));
}
