import { abrLookupFromEnv } from "../adapters/abr-lookup";
import { checkAbn, type AbnCheckResult, type AbnLookupPort } from "../domain/abn";
import { withinLimit, windowStart } from "../domain/rate-limit";
import { sha256Hex } from "../domain/phone-verification";
import type { Failure, Result } from "../domain/listing-service";
import type { Queryable } from "./db";
import { countHitPg } from "./offer-flow-db";

/** ABR lookups per signed-in person per 10 minutes. Each one can call an external service, so the limit is low. */
export const ABN_CHECK_RATE = { windowMs: 10 * 60 * 1000, perPerson: 20 } as const;

export interface AbnCheckDeps { hit(bucket: string, windowMs: number): Promise<number | undefined>; port: AbnLookupPort | null }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

/** Rate-limited ABN check for one signed-in person. The hit is counted first, and an unusable counter refuses (fails closed). */
export async function runAbnCheck(d: AbnCheckDeps, personId: string, abn: unknown): Promise<Result<AbnCheckResult>> {
  if (!withinLimit(await d.hit(sha256Hex(`abn-check:${personId}`), ABN_CHECK_RATE.windowMs), ABN_CHECK_RATE.perPerson)) {
    return fail("rate_limited", "Too many ABN checks. Try again in a few minutes.");
  }
  return { ok: true, value: await checkAbn(abn, d.port) };
}

export const abnCheckDeps = (db: Queryable): AbnCheckDeps => ({
  hit: (bucket, windowMs) => countHitPg(db, bucket, windowStart(new Date().toISOString(), windowMs)),
  port: abrLookupFromEnv()
});
