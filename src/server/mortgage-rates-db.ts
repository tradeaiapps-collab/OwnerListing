import { parseRbaF5, RATE_SERIES, type RateObservation } from "../domain/mortgage";
import type { Queryable } from "./db";

export const RBA_F5_URL = "https://www.rba.gov.au/statistics/tables/csv/f5-data.csv";
const MAX_BYTES = 2_000_000;

export interface RateRow { date: string; ratePct: number }

const rows = (r: { rows: Record<string, unknown>[] }): RateRow[] =>
  r.rows.map(x => ({ date: x["rate_date"] instanceof Date ? x["rate_date"].toISOString().slice(0, 10) : String(x["rate_date"]).slice(0, 10), ratePct: Number(x["rate_pct"]) }));

export async function latestRate(db: Queryable): Promise<RateRow | null> {
  return rows(await db.query("SELECT rate_date, rate_pct FROM mortgage_rate WHERE series = $1 ORDER BY rate_date DESC LIMIT 1", [RATE_SERIES]))[0] ?? null;
}

/** Newest first, at most `months` rows (1 to 240). */
export async function rateHistory(db: Queryable, months: number): Promise<RateRow[]> {
  const n = Math.min(240, Math.max(1, Math.floor(months) || 60));
  return rows(await db.query("SELECT rate_date, rate_pct FROM mortgage_rate WHERE series = $1 ORDER BY rate_date DESC LIMIT $2", [RATE_SERIES, n]));
}

export async function saveRates(db: Queryable, obs: RateObservation[]): Promise<number> {
  let n = 0;
  for (const o of obs) {
    await db.query(
      `INSERT INTO mortgage_rate (series, rate_date, rate_pct) VALUES ($1,$2,$3)
       ON CONFLICT (series, rate_date) DO UPDATE SET rate_pct = EXCLUDED.rate_pct, fetched_at = now()
       WHERE mortgage_rate.rate_pct IS DISTINCT FROM EXCLUDED.rate_pct`, [RATE_SERIES, o.date, o.ratePct]);
    n++;
  }
  return n;
}

/** Downloads the RBA table and stores every month it holds. Throws on a bad response so the scheduler run fails visibly. */
export async function refreshMortgageRates(db: Queryable, fetchFn: typeof fetch): Promise<{ stored: number; latest: RateRow | null }> {
  const res = await fetchFn(RBA_F5_URL, { headers: { accept: "text/csv" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`RBA rates download failed (${res.status}).`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("RBA rates file is unexpectedly large.");
  const obs = parseRbaF5(text);
  if (obs.length === 0) throw new Error("RBA rates file has no usable standard variable owner-occupier column.");
  const stored = await saveRates(db, obs);
  return { stored, latest: await latestRate(db) };
}
