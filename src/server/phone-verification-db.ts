import type { Queryable } from "./db";
import { countHitPg } from "./offer-flow-db";
import { windowStart } from "../domain/rate-limit";
import type { IdResult, IdStore } from "./id-check";
import type { LiveCode, PhoneStore } from "./phone-verification";

const nowIso = () => new Date().toISOString();

/** Postgres store for the mobile-verification flow. Every statement is parameterised. */
export function createPgPhoneStore(db: Queryable): PhoneStore {
  return {
    hit: (bucket, windowMs) => countHitPg(db, bucket, windowStart(nowIso(), windowMs)),
    async state(userId) {
      const r = await db.query("SELECT email_verified_at IS NOT NULL AS e, phone_verified_at IS NOT NULL AS p FROM buyer_verification WHERE user_id = $1::uuid", [userId]);
      return { emailVerified: r.rows[0]?.["e"] === true, phoneVerified: r.rows[0]?.["p"] === true };
    },
    async recordConsent(userId, version) {
      await db.query("INSERT INTO phone_sms_consent (user_id, wording_version) VALUES ($1::uuid, $2)", [userId, version]);
    },
    async createCode(userId, codeId, phone, hash, expiresAt) {
      await db.query("UPDATE phone_code SET consumed_at = now() WHERE user_id = $1::uuid AND consumed_at IS NULL", [userId]);
      await db.query(
        "INSERT INTO phone_code (id, user_id, phone_e164, code_hash, expires_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz)",
        [codeId, userId, phone, hash, expiresAt]);
    },
    async takeGuess(userId, maxAttempts): Promise<LiveCode | "none" | "locked"> {
      const r = await db.query(
        `UPDATE phone_code SET attempts = attempts + 1
          WHERE id = (SELECT id FROM phone_code WHERE user_id = $1::uuid AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1)
            AND consumed_at IS NULL AND attempts < $2
        RETURNING id, phone_e164, code_hash, expires_at <= now() AS expired`, [userId, maxAttempts]);
      const row = r.rows[0];
      if (row) return { id: String(row["id"]), phoneE164: String(row["phone_e164"]), codeHash: String(row["code_hash"]), expired: row["expired"] === true };
      const open = await db.query("SELECT 1 FROM phone_code WHERE user_id = $1::uuid AND consumed_at IS NULL AND expires_at > now() LIMIT 1", [userId]);
      return open.rows.length > 0 ? "locked" : "none";
    },
    async consume(codeId, userId) {
      const r = await db.query("UPDATE phone_code SET consumed_at = now() WHERE id = $1::uuid AND user_id = $2::uuid AND consumed_at IS NULL RETURNING id", [codeId, userId]);
      return r.rows.length === 1;
    },
    async markVerified(userId, phone) {
      await db.query(
        `INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1::uuid, now(), $2)
         ON CONFLICT (user_id) DO UPDATE SET phone_verified_at = now(), phone_e164 = EXCLUDED.phone_e164`, [userId, phone]);
    },
    async log(userId, event, ipHash) {
      await db.query("INSERT INTO phone_attempt_log (user_id, event, ip_hash) VALUES ($1::uuid, $2, $3)", [userId, event, ipHash]);
    }
  };
}

/** Postgres store for the provider ID check. Keeps the provider reference and outcome only. */
export function createPgIdStore(db: Queryable): IdStore {
  return {
    hit: (bucket, windowMs) => countHitPg(db, bucket, windowStart(nowIso(), windowMs)),
    async state(userId) {
      const r = await db.query("SELECT phone_verified_at IS NOT NULL AS p, id_verified_at IS NOT NULL AS i FROM buyer_verification WHERE user_id = $1::uuid", [userId]);
      return { phoneVerified: r.rows[0]?.["p"] === true, idVerified: r.rows[0]?.["i"] === true };
    },
    async recordSession(userId, providerRef) {
      await db.query("INSERT INTO id_check_session (user_id, provider_ref) VALUES ($1::uuid, $2)", [userId, providerRef]);
    },
    async log(userId, event, providerRef) {
      await db.query("INSERT INTO id_check_log (user_id, event, provider_ref) VALUES ($1::uuid, $2, $3)", [userId, event, providerRef]);
    },
    async applyResult(eventId, providerRef, outcome): Promise<IdResult> {
      if (!db.transaction) throw new Error("Transactions are required.");
      return db.transaction(async tx => {
        const logged = await tx.query(
          "INSERT INTO id_check_log (event, provider_ref, event_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id",
          [outcome === "passed" ? "result_passed" : "result_failed", providerRef, eventId]);
        if (logged.rows.length === 0) return "duplicate";
        const s = await tx.query(
          "UPDATE id_check_session SET outcome = $2, decided_at = now() WHERE provider_ref = $1 AND outcome = 'started' RETURNING user_id",
          [providerRef, outcome]);
        const userId = s.rows[0]?.["user_id"];
        if (typeof userId !== "string") {
          const known = await tx.query("SELECT 1 FROM id_check_session WHERE provider_ref = $1", [providerRef]);
          // Known but already decided: the first result stands. Never issued: nothing changes.
          return known.rows.length > 0 ? "applied" : "unknown";
        }
        if (outcome === "passed") {
          await tx.query(
            `INSERT INTO buyer_verification (user_id, id_verified_at, id_method, id_provider_ref) VALUES ($1::uuid, now(), 'provider', $2)
             ON CONFLICT (user_id) DO UPDATE SET id_verified_at = now(), id_method = 'provider', id_provider_ref = EXCLUDED.id_provider_ref`,
            [userId, providerRef]);
        }
        return "applied";
      });
    }
  };
}
