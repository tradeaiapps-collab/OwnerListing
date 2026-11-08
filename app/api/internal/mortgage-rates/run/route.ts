import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { refreshMortgageRates } from "../../../../../src/server/mortgage-rates-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Scheduler tick that refreshes published home-loan rates (.github/workflows/mortgage-rates.yml, daily).
 * FAILS CLOSED: 503 while MORTGAGE_RATES_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (SHA-256 digests, constant time).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["MORTGAGE_RATES_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Rates worker is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  try {
    const r = await refreshMortgageRates(getDb(), fetch);
    return NextResponse.json({ stored: r.stored, latest: r.latest });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Rates refresh failed." }, { status: 502 });
  }
}

export const POST = withApi(handlePost);
