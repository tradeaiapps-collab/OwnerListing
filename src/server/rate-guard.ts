import { createHash } from "node:crypto";
import { windowStart, withinLimit } from "../domain/rate-limit";
import type { Queryable } from "./db";
import { countHitPg } from "./offer-flow-db";

export interface RateRule { windowMs: number; limit: number }

/**
 * Counts one hit against every bucket (all are counted every time, so a refused attempt still uses up the other limits) and says
 * whether all of them are still within their limit. Bucket names are hashes of label and key (64 characters, no raw IP or email stored).
 * Fails closed: a database error counts as over the limit.
 */
export async function withinRates(db: Queryable, label: string, keys: readonly string[], rule: RateRule, now: Date = new Date()): Promise<boolean> {
  const start = windowStart(now.toISOString(), rule.windowMs);
  try {
    let ok = true;
    for (const key of keys) {
      const hits = await countHitPg(db, createHash("sha256").update(`rate-guard:${label}:${key}`).digest("hex"), start);
      if (!withinLimit(hits, rule.limit)) ok = false;
    }
    return ok;
  } catch { return false; }
}
