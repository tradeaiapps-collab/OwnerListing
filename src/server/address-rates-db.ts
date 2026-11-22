import type { Jurisdiction } from "../domain/jurisdiction";
import type { ListingRates, RatePeriod } from "../domain/listing-rates";
import { addressKey, type RatesRecord } from "../domain/rates-provider";
import type { Queryable } from "./db";

const SELECT = `SELECT state, address, council_cents, council_period, water_cents, water_period, water_usage_billed_separately, source,
  to_char(as_at, 'YYYY-MM-DD') AS as_at FROM address_rates`;

const map = (r: Record<string, unknown>): RatesRecord => {
  const rates: ListingRates = {};
  if (r["council_cents"] !== null) rates.council = { cents: Number(r["council_cents"]), period: r["council_period"] as RatePeriod };
  if (r["water_cents"] !== null) rates.water = { cents: Number(r["water_cents"]), period: r["water_period"] as RatePeriod };
  if (r["water_usage_billed_separately"] !== null) rates.waterUsageBilledSeparately = r["water_usage_billed_separately"] as boolean;
  return { state: r["state"] as Jurisdiction, address: r["address"] as string, rates, source: r["source"] as string, asAt: r["as_at"] as string };
};

export async function findAddressRatesPg(db: Queryable, state: string, address: string): Promise<RatesRecord | null> {
  const { rows } = await db.query(`${SELECT} WHERE state = $1 AND address_key = $2`, [state, addressKey(address)]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listAddressRatesPg(db: Queryable, q: string, limit = 100): Promise<{ rows: RatesRecord[]; total: number }> {
  const t = q.trim().toLowerCase();
  const like = `%${t.replace(/[%_\\]/g, m => `\\${m}`)}%`;
  const where = t ? "WHERE address_key LIKE $1" : "";
  const params = t ? [like] : [];
  const { rows } = await db.query(`${SELECT} ${where} ORDER BY updated_at DESC, state, address_key LIMIT ${Math.min(Math.max(limit, 1), 200)}`, params);
  const c = await db.query(`SELECT count(*)::int AS n FROM address_rates ${where}`, params);
  return { rows: rows.map(map), total: Number(c.rows[0]?.["n"] ?? 0) };
}

/** Upserts every row in one transaction. A later file replaces an address already loaded. Returns how many addresses were new. */
export async function importAddressRatesPg(db: Queryable, rows: readonly { state: Jurisdiction; address: string; rates: ListingRates }[], meta: { source: string; asAt: string; userId: string; now: string }): Promise<{ created: number; updated: number }> {
  const run = async (q: Queryable) => {
    let created = 0;
    for (const r of rows) {
      const res = await q.query(
        `INSERT INTO address_rates (state, address_key, address, council_cents, council_period, water_cents, water_period, water_usage_billed_separately, source, as_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (state, address_key) DO UPDATE SET address=$3, council_cents=$4, council_period=$5, water_cents=$6, water_period=$7,
           water_usage_billed_separately=$8, source=$9, as_at=$10, updated_by=$11, updated_at=$12
         RETURNING (xmax = 0) AS inserted`,
        [r.state, addressKey(r.address), r.address, r.rates.council?.cents ?? null, r.rates.council?.period ?? null, r.rates.water?.cents ?? null,
         r.rates.water?.period ?? null, r.rates.waterUsageBilledSeparately ?? null, meta.source, meta.asAt, meta.userId, meta.now]);
      if (res.rows[0]?.["inserted"] === true) created++;
    }
    return { created, updated: rows.length - created };
  };
  return db.transaction ? db.transaction(run) : run(db);
}
