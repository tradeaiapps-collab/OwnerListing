import type { ContractorCandidate, ContractorProfile, ContractorProfileStore, DispatchKind } from "../domain/contractor-dispatch";
import type { Queryable } from "./db";

// Constant SQL text; input only as bound parameters. The user id for writes comes from the session.
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
export const CANDIDATES_SQL =
  "SELECT u.id, u.display_name, p.accepting_new, p.service_postcodes, p.service_suburbs, " +
  "(SELECT count(*) FROM job_assignment a WHERE a.contractor_user_id = u.id AND a.status IN ('proposed','approved')) AS open_jobs " +
  "FROM contractor_profile p JOIN app_user u ON u.id = p.user_id " +
  "WHERE p.kind = $1::text AND p.accepting_new AND u.status NOT IN ('suspended','closed') AND u.user_type IN ('vendor','agent') ORDER BY u.id LIMIT 2000";
export const GET_SQL = "SELECT accepting_new, service_postcodes, service_suburbs FROM contractor_profile WHERE user_id = $1::uuid AND kind = $2::text";
export const UPSERT_SQL =
  "INSERT INTO contractor_profile (user_id, kind, accepting_new, service_postcodes, service_suburbs, updated_at) VALUES ($1::uuid, $2::text, $3, $4::text[], $5::text[], now()) " +
  "ON CONFLICT (user_id, kind) DO UPDATE SET accepting_new = EXCLUDED.accepting_new, service_postcodes = EXCLUDED.service_postcodes, service_suburbs = EXCLUDED.service_suburbs, updated_at = now()";

const toProfile = (r: Record<string, unknown>): ContractorProfile => ({ acceptingNew: r["accepting_new"] === true, servicePostcodes: list(r["service_postcodes"]), serviceSuburbs: list(r["service_suburbs"]) });

export function createPgContractorProfileStore(db: Queryable): ContractorProfileStore {
  return {
    async candidates(kind: DispatchKind) {
      const { rows } = await db.query(CANDIDATES_SQL, [kind]);
      return rows.map((r): ContractorCandidate => ({ userId: String(r["id"]), displayName: String(r["display_name"]), profile: toProfile(r), openJobs: Number(r["open_jobs"]) }));
    },
    async get(userId, kind) { const r = (await db.query(GET_SQL, [userId, kind])).rows[0]; return r ? toProfile(r) : undefined; },
    async save(userId, kind, p) { await db.query(UPSERT_SQL, [userId, kind, p.acceptingNew, p.servicePostcodes, p.serviceSuburbs]); }
  };
}
