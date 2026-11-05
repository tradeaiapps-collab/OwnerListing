import { randomUUID } from "node:crypto";
import type { AgentCandidate, AgentMatchingRepository, AgentProfile } from "../domain/agent-matching";
import { isJurisdiction } from "../domain/jurisdiction";
import { getDb } from "./context";
import { appendAuditPg, verifiedLicencesPg, type Queryable } from "./db";

// Constant SQL text; user input only travels as bound parameters. The agent id for profile writes comes from the session.

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));

export const LISTING_FACTS_SQL =
  "SELECT owner_user_id, jurisdiction, postcode, suburb, transaction_type, use_class, property_type FROM property_listing WHERE id = $1::uuid";
/** Param: 1 state. Expiry is judged by the domain (state-local date); this only narrows to verified licence rows. */
export const CANDIDATES_SQL =
  "SELECT u.id, u.display_name, p.accepting_new, p.max_active_listings, p.service_postcodes, p.service_suburbs, p.transaction_types, " +
  "p.use_classes, p.property_types, p.bio, " +
  "(SELECT count(*) FROM listing_agent_appointment a WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL) AS active " +
  "FROM agent_profile p JOIN app_user u ON u.id = p.user_id " +
  "WHERE u.user_type = 'agent' AND u.status = 'active' AND p.accepting_new " +
  "AND EXISTS (SELECT 1 FROM agent_licence l WHERE l.user_id = u.id AND l.jurisdiction = $1::text AND l.status = 'verified') " +
  "ORDER BY u.id LIMIT 2000";
export const GET_PROFILE_SQL =
  "SELECT accepting_new, max_active_listings, service_postcodes, service_suburbs, transaction_types, use_classes, property_types, bio " +
  "FROM agent_profile WHERE user_id = $1::uuid";
export const UPSERT_PROFILE_SQL =
  "INSERT INTO agent_profile (user_id, accepting_new, max_active_listings, service_postcodes, service_suburbs, transaction_types, use_classes, property_types, bio, updated_at) " +
  "VALUES ($1::uuid, $2, $3, $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9, $10::timestamptz) " +
  "ON CONFLICT (user_id) DO UPDATE SET accepting_new = EXCLUDED.accepting_new, max_active_listings = EXCLUDED.max_active_listings, " +
  "service_postcodes = EXCLUDED.service_postcodes, service_suburbs = EXCLUDED.service_suburbs, transaction_types = EXCLUDED.transaction_types, " +
  "use_classes = EXCLUDED.use_classes, property_types = EXCLUDED.property_types, bio = EXCLUDED.bio, updated_at = EXCLUDED.updated_at";

const toProfile = (r: Record<string, unknown>): AgentProfile => ({
  acceptingNew: r["accepting_new"] === true, maxActiveListings: Number(r["max_active_listings"]),
  servicePostcodes: list(r["service_postcodes"]), serviceSuburbs: list(r["service_suburbs"]), transactionTypes: list(r["transaction_types"]),
  useClasses: list(r["use_classes"]), propertyTypes: list(r["property_types"]), bio: String(r["bio"] ?? "")
});

export function createPgAgentMatchingRepository(db: Queryable): AgentMatchingRepository {
  return {
    async getListingFacts(id) {
      const r = (await db.query(LISTING_FACTS_SQL, [id])).rows[0];
      const jurisdiction = r ? String(r["jurisdiction"]).trim() : "";
      if (!r || !isJurisdiction(jurisdiction)) return undefined;
      return {
        ownerUserId: String(r["owner_user_id"]), jurisdiction,
        ...(r["postcode"] ? { postcode: String(r["postcode"]).trim() } : {}),
        ...(r["suburb"] ? { suburb: String(r["suburb"]) } : {}),
        transactionType: String(r["transaction_type"]), useClass: String(r["use_class"]), propertyType: String(r["property_type"])
      };
    },
    async candidates(jurisdiction) {
      const { rows } = await db.query(CANDIDATES_SQL, [jurisdiction]);
      return rows.map((r): AgentCandidate => ({
        userId: String(r["id"]), displayName: String(r["display_name"]), profile: toProfile(r), activeListings: Number(r["active"])
      }));
    },
    async getProfile(userId) {
      const r = (await db.query(GET_PROFILE_SQL, [userId])).rows[0];
      return r ? toProfile(r) : undefined;
    },
    async saveProfile(userId, p, audit) {
      await atomic(db, async tx => {
        await tx.query(UPSERT_PROFILE_SQL, [userId, p.acceptingNew, p.maxActiveListings, p.servicePostcodes, p.serviceSuburbs,
          p.transactionTypes, p.useClasses, p.propertyTypes, p.bio, audit.occurredAt]);
        await appendAuditPg(tx, audit);
      });
    },
    verifiedLicences: () => verifiedLicencesPg(db)
  };
}

export const getAgentMatchingRepo = () => createPgAgentMatchingRepository(getDb());
export const matchingIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
