import type { MfaMethod } from "../domain/mfa";
import { windowStart } from "../domain/rate-limit";
import type { Queryable } from "./db";
import type { LiveSmsCode, MfaFactor, MfaStore } from "./mfa";
import { countHitPg } from "./offer-flow-db";

const nowIso = () => new Date().toISOString();

/** Postgres store for multi-factor sign-in. Every statement is parameterised. */
export function createPgMfaStore(db: Queryable): MfaStore {
  return {
    hit: (bucket, windowMs) => countHitPg(db, bucket, windowStart(nowIso(), windowMs)),
    async factors(userId) {
      const r = await db.query(
        `SELECT id, kind, secret_sealed, phone_e164, last_used_step, confirmed_at IS NOT NULL AS confirmed, created_at
           FROM mfa_factor WHERE user_id = $1::uuid AND revoked_at IS NULL ORDER BY created_at`, [userId]);
      return r.rows.map((row): MfaFactor => ({
        id: String(row["id"]),
        kind: row["kind"] as MfaMethod,
        confirmed: row["confirmed"] === true,
        ...(typeof row["secret_sealed"] === "string" ? { secretSealed: row["secret_sealed"] } : {}),
        ...(typeof row["phone_e164"] === "string" ? { phoneE164: row["phone_e164"] } : {}),
        lastUsedStep: Number(row["last_used_step"] ?? 0),
        createdAt: new Date(row["created_at"] as string).toISOString()
      }));
    },
    async accountLabel(userId) {
      const r = await db.query("SELECT email::text AS email FROM app_user WHERE id = $1::uuid", [userId]);
      return typeof r.rows[0]?.["email"] === "string" ? r.rows[0]["email"] : "account";
    },
    async startFactor(userId, kind, value) {
      await db.query("UPDATE mfa_factor SET revoked_at = now() WHERE user_id = $1::uuid AND kind = $2 AND confirmed_at IS NULL AND revoked_at IS NULL", [userId, kind]);
      const r = await db.query(
        "INSERT INTO mfa_factor (user_id, kind, secret_sealed, phone_e164) VALUES ($1::uuid, $2, $3, $4) RETURNING id",
        [userId, kind, "secretSealed" in value ? value.secretSealed : null, "phoneE164" in value ? value.phoneE164 : null]);
      return String(r.rows[0]!["id"]);
    },
    async confirmFactor(factorId, userId) {
      const r = await db.query(
        "UPDATE mfa_factor SET confirmed_at = now(), last_used_at = now() WHERE id = $1::uuid AND user_id = $2::uuid AND confirmed_at IS NULL AND revoked_at IS NULL RETURNING id",
        [factorId, userId]);
      return r.rows.length === 1;
    },
    async useTotpStep(factorId, userId, step) {
      const r = await db.query(
        "UPDATE mfa_factor SET last_used_step = $3 WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL AND last_used_step < $3 RETURNING id",
        [factorId, userId, step]);
      return r.rows.length === 1;
    },
    async markUsed(factorId, userId) {
      await db.query("UPDATE mfa_factor SET last_used_at = now() WHERE id = $1::uuid AND user_id = $2::uuid", [factorId, userId]);
    },
    async revokeFactor(factorId, userId) {
      const r = await db.query("UPDATE mfa_factor SET revoked_at = now() WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL RETURNING id", [factorId, userId]);
      return r.rows.length === 1;
    },
    async createSmsCode(userId, factorId, codeId, codeHash, expiresAt) {
      await db.query("UPDATE mfa_sms_code SET consumed_at = now() WHERE user_id = $1::uuid AND consumed_at IS NULL", [userId]);
      await db.query(
        "INSERT INTO mfa_sms_code (id, user_id, factor_id, code_hash, expires_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)",
        [codeId, userId, factorId, codeHash, expiresAt]);
    },
    async takeSmsGuess(userId, factorId, maxAttempts): Promise<LiveSmsCode | "none" | "locked"> {
      const r = await db.query(
        `UPDATE mfa_sms_code SET attempts = attempts + 1
          WHERE id = (SELECT id FROM mfa_sms_code WHERE user_id = $1::uuid AND factor_id = $2::uuid AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1)
            AND consumed_at IS NULL AND attempts < $3
        RETURNING id, code_hash, expires_at <= now() AS expired`, [userId, factorId, maxAttempts]);
      const row = r.rows[0];
      if (row) return { id: String(row["id"]), codeHash: String(row["code_hash"]), expired: row["expired"] === true };
      const open = await db.query(
        "SELECT 1 FROM mfa_sms_code WHERE user_id = $1::uuid AND factor_id = $2::uuid AND consumed_at IS NULL AND expires_at > now() LIMIT 1", [userId, factorId]);
      return open.rows.length > 0 ? "locked" : "none";
    },
    async consumeSmsCode(codeId, userId) {
      const r = await db.query("UPDATE mfa_sms_code SET consumed_at = now() WHERE id = $1::uuid AND user_id = $2::uuid AND consumed_at IS NULL RETURNING id", [codeId, userId]);
      return r.rows.length === 1;
    },
    async replaceRecoveryCodes(userId, hashes) {
      const write = async (q: Queryable) => {
        await q.query("UPDATE mfa_recovery_code SET retired_at = now() WHERE user_id = $1::uuid AND retired_at IS NULL", [userId]);
        if (hashes.length) {
          await q.query("INSERT INTO mfa_recovery_code (user_id, code_hash) SELECT $1::uuid, unnest($2::text[])", [userId, hashes]);
        }
      };
      await (db.transaction ? db.transaction(write) : write(db));
    },
    async useRecoveryCode(userId, codeHash) {
      const r = await db.query(
        "UPDATE mfa_recovery_code SET used_at = now() WHERE user_id = $1::uuid AND code_hash = $2 AND used_at IS NULL AND retired_at IS NULL RETURNING id",
        [userId, codeHash]);
      return r.rows.length === 1;
    },
    async recoveryCodesLeft(userId) {
      const r = await db.query("SELECT count(*)::int AS n FROM mfa_recovery_code WHERE user_id = $1::uuid AND used_at IS NULL AND retired_at IS NULL", [userId]);
      return Number(r.rows[0]?.["n"] ?? 0);
    },
    async recordSmsConsent(userId, version) {
      await db.query("INSERT INTO phone_sms_consent (user_id, wording_version) VALUES ($1::uuid, $2)", [userId, version]);
    },
    async log(userId, event, method, ipHash) {
      await db.query("INSERT INTO mfa_event_log (user_id, event, method, ip_hash) VALUES ($1::uuid, $2, $3, $4)", [userId, event, method, ipHash]);
    }
  };
}

/** Whether the user has a confirmed second factor (used by sign-in to decide where to go next). */
export async function mfaEnrolledPg(db: Queryable, userId: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM mfa_factor WHERE user_id = $1::uuid AND confirmed_at IS NOT NULL AND revoked_at IS NULL LIMIT 1", [userId]);
  return r.rows.length > 0;
}
