import { createHmac, randomInt } from "node:crypto";
import type { PhoneChallenge, PhoneRepository, SmsPort } from "../domain/phone-verification";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export function createPgPhoneRepository(db: Queryable): PhoneRepository {
  return {
    async insertChallenge(c) {
      await db.query(
        "INSERT INTO phone_challenge (id, user_id, phone_e164, code_hash, expires_at, attempts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [c.id, c.userId, c.phoneE164, c.codeHash, c.expiresAt, c.attempts, c.createdAt]
      );
    },
    async latestOpen(userId) {
      const r = await db.query(
        "SELECT * FROM phone_challenge WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1", [userId]
      );
      const row = r.rows[0];
      if (!row) return undefined;
      const c: PhoneChallenge = {
        id: String(row["id"]), userId: String(row["user_id"]), phoneE164: String(row["phone_e164"]), codeHash: String(row["code_hash"]),
        expiresAt: iso(row["expires_at"]), attempts: Number(row["attempts"]), createdAt: iso(row["created_at"])
      };
      return c;
    },
    async sendsSince(userId, phone, since) {
      const r = await db.query(
        `SELECT count(*) FILTER (WHERE user_id = $1) AS by_user, count(*) FILTER (WHERE phone_e164 = $2) AS by_phone
         FROM phone_challenge WHERE created_at >= $3`, [userId, phone, since]
      );
      return { byUser: Number(r.rows[0]?.["by_user"] ?? 0), byPhone: Number(r.rows[0]?.["by_phone"] ?? 0) };
    },
    async bumpAttempts(id) {
      const r = await db.query("UPDATE phone_challenge SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts", [id]);
      return Number(r.rows[0]?.["attempts"] ?? Number.MAX_SAFE_INTEGER);
    },
    async consume(id, now) {
      await db.query("UPDATE phone_challenge SET consumed_at = $2 WHERE id = $1", [id, now]);
    },
    async markVerified(userId, phone, now) {
      try {
        await db.query(
          `INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1, $3, $2)
           ON CONFLICT (user_id) DO UPDATE SET phone_verified_at = $3, phone_e164 = $2`,
          [userId, phone, now]
        );
        return true;
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") return false;
        throw e;
      }
    }
  };
}

export const hashCodeWith = (secret: string) => (challengeId: string, code: string) =>
  createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("hex");

export const newSixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/**
 * No real SMS provider is chosen yet, so by default there is none and verification stays blocked.
 * SMS_PROVIDER=console prints the code to the server log for local testing and is ignored in production.
 */
export function smsFromEnv(env: Record<string, string | undefined> = process.env): SmsPort | undefined {
  if (env["SMS_PROVIDER"] === "console" && env["NODE_ENV"] !== "production") {
    return { async send(to, text) { console.log(`[sms:console] to ${to}: ${text}`); } };
  }
  return undefined;
}
