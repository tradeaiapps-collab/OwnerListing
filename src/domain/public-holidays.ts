/**
 * Public holidays by Australian state, for counting business days (cooling-off). Pure functions; the list itself lives in the
 * public_holidays table and staff maintain it at /staff/public-holidays. `standardHolidays` proposes the usual dates for a year
 * (Easter-based and "nth Monday" holidays included) so staff only add the ones announced year to year (WA King's Birthday,
 * VIC Grand Final Friday, local show days). Counsel has not confirmed which days count as business days.
 */
export const HOLIDAY_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const;
export type HolidayState = (typeof HOLIDAY_STATES)[number];
export const isHolidayState = (v: unknown): v is HolidayState => typeof v === "string" && (HOLIDAY_STATES as readonly string[]).includes(v);

export interface Holiday { state: HolidayState; date: string; name: string }

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const dow = (t: number) => new Date(t).getUTCDay(); // 0 Sunday

/** A real calendar date in YYYY-MM-DD form. */
export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(ms(v)) && iso(ms(v)) === v;
}

/** Easter Sunday for a Gregorian year (anonymous Gregorian algorithm), as a UTC millisecond day. */
export function easterSunday(year: number): number {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** The nth Monday (1 = first) of a month. */
const nthMonday = (y: number, m: number, n: number) => { const first = utc(y, m, 1); return first + (((8 - dow(first)) % 7) + 7 * (n - 1)) * DAY; };
/** The first Monday on or after a date. */
const mondayOnOrAfter = (t: number) => t + ((8 - dow(t)) % 7) * DAY;
/** A fixed date that moves to Monday when it falls on a weekend. */
const mondayise = (t: number) => (dow(t) === 6 ? t + 2 * DAY : dow(t) === 0 ? t + DAY : t);

/** The usual weekday holidays for a state and year. Weekend-only days are left out because weekends are never counted anyway. */
export function standardHolidays(state: HolidayState, year: number): Holiday[] {
  const out: { t: number; name: string }[] = [];
  const add = (t: number, name: string) => out.push({ t, name });
  const easter = easterSunday(year);
  add(mondayise(utc(year, 1, 1)), "New Year's Day");
  add(mondayise(utc(year, 1, 26)), "Australia Day");
  add(easter - 2 * DAY, "Good Friday");
  add(easter + DAY, "Easter Monday");
  // Anzac Day moves only in WA and NT (a Sunday goes to Monday).
  const anzac = utc(year, 4, 25);
  add((state === "WA" || state === "NT") && dow(anzac) === 0 ? anzac + DAY : anzac, "Anzac Day");
  // Christmas: Saturday goes to Monday, Sunday to Tuesday; Boxing Day: Saturday to Monday, Sunday to Tuesday.
  const xmas = utc(year, 12, 25), boxing = utc(year, 12, 26);
  add(dow(xmas) === 6 ? xmas + 2 * DAY : dow(xmas) === 0 ? xmas + 2 * DAY : xmas, "Christmas Day");
  add(dow(boxing) === 6 ? boxing + 2 * DAY : dow(boxing) === 0 ? boxing + 2 * DAY : boxing, "Boxing Day");
  if (state === "QLD") add(nthMonday(year, 10, 1), "King's Birthday");
  else if (state !== "WA") add(nthMonday(year, 6, 2), "King's Birthday");
  switch (state) {
    case "NSW": add(nthMonday(year, 10, 1), "Labour Day"); break;
    case "ACT": add(nthMonday(year, 10, 1), "Labour Day"); add(nthMonday(year, 3, 2), "Canberra Day"); add(mondayOnOrAfter(utc(year, 5, 27)), "Reconciliation Day"); break;
    case "SA": add(nthMonday(year, 10, 1), "Labour Day"); break;
    case "VIC": add(nthMonday(year, 3, 2), "Labour Day"); break;
    case "TAS": add(nthMonday(year, 3, 2), "Eight Hours Day"); break;
    case "WA": add(nthMonday(year, 3, 1), "Labour Day"); add(nthMonday(year, 6, 1), "Western Australia Day"); break;
    case "QLD": add(nthMonday(year, 5, 1), "Labour Day"); break;
    case "NT": add(nthMonday(year, 5, 1), "May Day"); add(nthMonday(year, 8, 1), "Picnic Day"); break;
  }
  const seen = new Set<string>();
  return out.filter(h => dow(h.t) !== 0 && dow(h.t) !== 6).sort((a, b) => a.t - b.t)
    .map(h => ({ state, date: iso(h.t), name: h.name })).filter(h => !seen.has(h.date) && !!seen.add(h.date));
}

export interface HolidayInput { state: HolidayState; date: string; name: string }
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Body of an add or update request: { state, date (YYYY-MM-DD), name (2 to 80 characters) }. */
export function parseHolidayInput(body: Record<string, unknown> | null): Result<HolidayInput> {
  if (!body) return { ok: false, error: "Send the holiday." };
  const state = typeof body["state"] === "string" ? body["state"].toUpperCase() : "";
  if (!isHolidayState(state)) return { ok: false, error: "Choose a state or territory." };
  const date = body["date"];
  if (!isIsoDate(date)) return { ok: false, error: "Enter the date as YYYY-MM-DD." };
  const year = Number(date.slice(0, 4));
  if (year < 2000 || year > 2100) return { ok: false, error: "The year must be between 2000 and 2100." };
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Name the holiday in 2 to 80 characters." };
  return { ok: true, value: { state, date, name } };
}

/** Body of "fill in the usual holidays": { state: "NSW" | ... | "ALL", year }. */
export function parseGenerateInput(body: Record<string, unknown> | null): Result<{ states: HolidayState[]; year: number }> {
  if (!body) return { ok: false, error: "Send the state and year." };
  const year = body["year"];
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) return { ok: false, error: "The year must be between 2000 and 2100." };
  const s = typeof body["state"] === "string" ? body["state"].toUpperCase() : "";
  if (s === "ALL") return { ok: true, value: { states: [...HOLIDAY_STATES], year } };
  if (!isHolidayState(s)) return { ok: false, error: "Choose a state or territory, or all of them." };
  return { ok: true, value: { states: [s], year } };
}
