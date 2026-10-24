import type { AccountSettings } from "../domain/account-settings";
import { DEFAULT_SETTINGS } from "../domain/account-settings";
import { currentTermsVersion, termsGate, type TermsAcceptance, type TermsVersionRow } from "../domain/terms";
import type { Queryable } from "./db";

// Every statement has constant text; user input only travels as a bound parameter.
// terms_acceptance is insert-only (db trigger too): there is no UPDATE or DELETE on it anywhere.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function listTermsVersions(db: Queryable): Promise<TermsVersionRow[]> {
  const r = await db.query("SELECT version, includes_ai_learning_clause, text_reference, effective_at FROM terms_version ORDER BY effective_at DESC");
  return r.rows.map(x => ({
    version: String(x["version"]), includesAiLearningClause: x["includes_ai_learning_clause"] === true,
    textReference: String(x["text_reference"]), effectiveAt: iso(x["effective_at"])
  }));
}

export async function listAcceptances(db: Queryable, userId: string): Promise<TermsAcceptance[]> {
  const r = await db.query("SELECT user_id, version FROM terms_acceptance WHERE user_id = $1::uuid", [userId]);
  return r.rows.map(x => ({ userId: String(x["user_id"]), version: String(x["version"]) }));
}

export async function recordAcceptance(db: Queryable, userId: string, version: string): Promise<void> {
  await db.query("INSERT INTO terms_acceptance (user_id, version) VALUES ($1::uuid, $2) ON CONFLICT (user_id, version) DO NOTHING", [userId, version]);
}

/** True only when the user accepted the version in force now. Fails closed on any lookup problem. */
export async function hasCurrentTermsPg(db: Queryable, userId: string, nowIso: string): Promise<boolean> {
  try {
    const current = currentTermsVersion(await listTermsVersions(db), nowIso);
    return termsGate(await listAcceptances(db, userId), userId, current) === null;
  } catch {
    return false;
  }
}

export async function getSettingsPg(db: Queryable, userId: string): Promise<AccountSettings> {
  const r = await db.query("SELECT locale, time_zone FROM user_preference WHERE user_id = $1::uuid", [userId]);
  const row = r.rows[0];
  return row ? { locale: String(row["locale"]), timeZone: String(row["time_zone"]) } : { ...DEFAULT_SETTINGS };
}

export async function saveSettingsPg(db: Queryable, userId: string, s: AccountSettings): Promise<void> {
  await db.query(
    `INSERT INTO user_preference (user_id, locale, time_zone, updated_at) VALUES ($1::uuid, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET locale = EXCLUDED.locale, time_zone = EXCLUDED.time_zone, updated_at = now()`,
    [userId, s.locale, s.timeZone]
  );
}
