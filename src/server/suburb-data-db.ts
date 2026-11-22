import { suburbKey, type SuburbMetrics, type SuburbRow } from "../domain/suburb-data";
import type { Jurisdiction } from "../domain/jurisdiction";
import type { Queryable } from "./db";

export interface StoredSuburb { state: Jurisdiction; suburb: string; postcode: string | null; metrics: SuburbMetrics; source: string; asAt: string; updatedAt: string }

const SELECT = `SELECT state, suburb, postcode, metrics, source, to_char(as_at, 'YYYY-MM-DD') AS as_at, updated_at FROM suburb_profile`;
const map = (r: Record<string, unknown>): StoredSuburb => ({
  state: r["state"] as Jurisdiction, suburb: r["suburb"] as string, postcode: (r["postcode"] as string | null) ?? null,
  metrics: r["metrics"] as SuburbMetrics, source: r["source"] as string, asAt: r["as_at"] as string,
  updatedAt: r["updated_at"] instanceof Date ? r["updated_at"].toISOString() : String(r["updated_at"])
});

export async function getSuburbPg(db: Queryable, state: string, suburb: string): Promise<StoredSuburb | null> {
  const { rows } = await db.query(`${SELECT} WHERE state = $1 AND suburb_key = $2`, [state, suburbKey(suburb)]);
  return rows[0] ? map(rows[0]) : null;
}

/** Staff list: newest first, optional text search on suburb or postcode, capped. */
export async function listSuburbsPg(db: Queryable, q: string, limit = 100): Promise<{ rows: StoredSuburb[]; total: number }> {
  const like = `%${q.trim().toLowerCase().replace(/[%_\\]/g, m => `\\${m}`)}%`;
  const where = q.trim() ? "WHERE suburb_key LIKE $1 OR postcode LIKE $1" : "";
  const params = q.trim() ? [like] : [];
  const { rows } = await db.query(`${SELECT} ${where} ORDER BY updated_at DESC, state, suburb_key LIMIT ${Math.min(Math.max(limit, 1), 200)}`, params);
  const c = await db.query(`SELECT count(*)::int AS n FROM suburb_profile ${where}`, params);
  return { rows: rows.map(map), total: Number(c.rows[0]?.["n"] ?? 0) };
}

/** Upserts every row and records the import, in one transaction when the pool provides it. Returns how many suburbs were new. */
export async function importSuburbsPg(db: Queryable, rows: readonly SuburbRow[], meta: { source: string; asAt: string; userId: string; now: string; importId: string }): Promise<{ created: number; updated: number }> {
  const run = async (q: Queryable) => {
    let created = 0;
    for (const r of rows) {
      const res = await q.query(
        `INSERT INTO suburb_profile (state, suburb_key, suburb, postcode, metrics, source, as_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
         ON CONFLICT (state, suburb_key) DO UPDATE SET suburb=$3, postcode=$4, metrics=$5::jsonb, source=$6, as_at=$7, updated_by=$8, updated_at=$9
         RETURNING (xmax = 0) AS inserted`,
        [r.state, suburbKey(r.suburb), r.suburb, r.postcode, JSON.stringify(r.metrics), meta.source, meta.asAt, meta.userId, meta.now]);
      if (res.rows[0]?.["inserted"] === true) created++;
    }
    await q.query(
      "INSERT INTO suburb_import (id, source, as_at, suburbs, created_suburbs, imported_by, imported_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [meta.importId, meta.source, meta.asAt, rows.length, created, meta.userId, meta.now]);
    return { created, updated: rows.length - created };
  };
  return db.transaction ? db.transaction(run) : run(db);
}
