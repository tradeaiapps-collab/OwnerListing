import { createFileComparablesSource } from "../adapters/comparables-file";
import { noComparablesSource, type ComparablesSource, type PriceEstimate } from "../domain/price-guidance";
import type { Queryable } from "./db";

/** PRICE_DATA_SOURCE=file with PRICE_DATA_FILE=/path/comparables.json, or unset for none ("Estimate unavailable"). */
export function getComparablesSource(env: Record<string, string | undefined> = process.env): ComparablesSource {
  const kind = (env["PRICE_DATA_SOURCE"] ?? "").trim().toLowerCase();
  const file = env["PRICE_DATA_FILE"]?.trim();
  if (kind === "file" && file) return createFileComparablesSource(file);
  return noComparablesSource;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface StoredEstimate extends Omit<PriceEstimate, "basis"> { id: string; listingId: string; source: string; createdAt: string }

export async function insertPriceEstimatePg(db: Queryable, id: string, listingId: string, e: PriceEstimate, source: string, at: string): Promise<void> {
  await db.query(
    `INSERT INTO price_estimate (id, listing_id, low_cents, mid_cents, high_cents, confidence, comparables, model_version, source, created_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::timestamptz)`,
    [id, listingId, e.lowCents, e.midCents, e.highCents, e.confidence, JSON.stringify(e.comparables), e.modelVersion, source, at]
  );
}

/** The newest stored estimate for a listing, if any. */
export async function latestPriceEstimatePg(db: Queryable, listingId: string): Promise<StoredEstimate | undefined> {
  const r = await db.query("SELECT * FROM price_estimate WHERE listing_id = $1::uuid ORDER BY created_at DESC LIMIT 1", [listingId]);
  const x = r.rows[0];
  if (!x) return undefined;
  return {
    id: String(x["id"]), listingId: String(x["listing_id"]), lowCents: Number(x["low_cents"]), midCents: Number(x["mid_cents"]),
    highCents: Number(x["high_cents"]), confidence: Number(x["confidence"]), comparables: x["comparables"] as PriceEstimate["comparables"],
    modelVersion: String(x["model_version"]), source: String(x["source"]), createdAt: iso(x["created_at"])
  };
}
