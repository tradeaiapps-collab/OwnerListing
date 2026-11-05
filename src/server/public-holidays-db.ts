import { standardHolidays, type Holiday, type HolidayInput, type HolidayState } from "../domain/public-holidays";
import type { Queryable } from "./db";

export interface HolidayRow extends Holiday { id: string }
const DAY_SQL = "to_char(holiday_date, 'YYYY-MM-DD')";
const row = (r: Record<string, unknown>): HolidayRow => ({ id: String(r["id"]), state: String(r["state"]) as HolidayState, date: String(r["day"]), name: String(r["name"]) });

/** Holidays for a year (all states, or one), oldest first. */
export async function listHolidaysPg(db: Queryable, year: number, state?: HolidayState): Promise<HolidayRow[]> {
  const r = await db.query(
    `SELECT id, state, ${DAY_SQL} AS day, name FROM public_holiday WHERE holiday_date >= $1::date AND holiday_date < $2::date AND ($3::text IS NULL OR state = $3) ORDER BY holiday_date, state`,
    [`${year}-01-01`, `${year + 1}-01-01`, state ?? null]);
  return r.rows.map(row);
}

/** The dates (YYYY-MM-DD) a state is off between two days, for the business-day count. */
export async function holidayDatesPg(db: Queryable, state: string, from: string, to: string): Promise<string[]> {
  const r = await db.query(`SELECT ${DAY_SQL} AS day FROM public_holiday WHERE state = $1 AND holiday_date >= $2::date AND holiday_date <= $3::date`, [state, from, to]);
  return r.rows.map(x => String(x["day"]));
}

/** Adds a holiday, or renames it when that state already has the date. `created` says which. */
export async function upsertHolidayPg(db: Queryable, h: HolidayInput, staffId: string): Promise<{ id: string; created: boolean }> {
  const r = await db.query(
    `INSERT INTO public_holiday (state, holiday_date, name, created_by) VALUES ($1, $2::date, $3, $4::uuid)
     ON CONFLICT (state, holiday_date) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id, (xmax = 0) AS created`, [h.state, h.date, h.name, staffId]);
  return { id: String(r.rows[0]!["id"]), created: r.rows[0]!["created"] === true };
}

export async function deleteHolidayPg(db: Queryable, id: string): Promise<HolidayRow | null> {
  const r = await db.query(`DELETE FROM public_holiday WHERE id = $1::uuid RETURNING id, state, ${DAY_SQL} AS day, name`, [id]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

/** Fills in the usual holidays for each state and year. Dates already on file keep their name. Returns how many were added. */
export async function generateHolidaysPg(db: Queryable, states: readonly HolidayState[], year: number, staffId: string): Promise<number> {
  let added = 0;
  for (const s of states) for (const h of standardHolidays(s, year)) {
    const r = await db.query(`INSERT INTO public_holiday (state, holiday_date, name, created_by) VALUES ($1, $2::date, $3, $4::uuid) ON CONFLICT (state, holiday_date) DO NOTHING RETURNING id`, [h.state, h.date, h.name, staffId]);
    added += r.rows.length;
  }
  return added;
}
