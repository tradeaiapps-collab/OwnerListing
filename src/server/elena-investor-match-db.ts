import type { InvestorProfileStore } from "../domain/elena-investor-match-service";
import type { InvestorPrefs } from "../domain/elena-investor-match";
import type { Jurisdiction } from "../domain/jurisdiction";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. NULL jurisdictions = location not asked yet; an empty array = anywhere. */
export function createPgProfileStore(db: Queryable): InvestorProfileStore {
  return {
    async get(userId) {
      const r = (await db.query("SELECT budget_max_cents, risk, jurisdictions, suburbs, timeframe FROM elena_investor_profile WHERE user_id = $1::uuid", [userId])).rows[0];
      if (!r) return undefined;
      const p: InvestorPrefs = { suburbs: (r["suburbs"] ?? []) as string[] };
      if (r["budget_max_cents"] !== null) p.budgetMaxCents = Number(r["budget_max_cents"]);
      if (r["risk"]) p.risk = r["risk"] as NonNullable<InvestorPrefs["risk"]>;
      if (r["jurisdictions"] !== null) p.jurisdictions = r["jurisdictions"] as Jurisdiction[];
      if (r["timeframe"]) p.timeframe = r["timeframe"] as NonNullable<InvestorPrefs["timeframe"]>;
      return p;
    },
    async save(userId, p, at) {
      await db.query(
        `INSERT INTO elena_investor_profile (user_id, budget_max_cents, risk, jurisdictions, suburbs, timeframe, created_at, updated_at)
         VALUES ($1::uuid, $2::bigint, $3, $4::text[], $5::text[], $6, $7::timestamptz, $7::timestamptz)
         ON CONFLICT (user_id) DO UPDATE SET budget_max_cents = EXCLUDED.budget_max_cents, risk = EXCLUDED.risk, jurisdictions = EXCLUDED.jurisdictions,
           suburbs = EXCLUDED.suburbs, timeframe = EXCLUDED.timeframe, updated_at = EXCLUDED.updated_at`,
        [userId, p.budgetMaxCents ?? null, p.risk ?? null, p.jurisdictions ?? null, p.suburbs, p.timeframe ?? null, at]);
    },
    async remove(userId) { await db.query("DELETE FROM elena_investor_profile WHERE user_id = $1::uuid", [userId]); }
  };
}
