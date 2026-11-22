import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb, getDeps } from "../../../../../src/server/context";
import { runMarketShiftAlerts } from "../../../../../src/server/market-intel-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Daily tick for Elena's market-shift alerts, called by a scheduler (not by browsers) with header x-cron-secret. Tells each agent about notable
 * changes in the areas they act in. FAILS CLOSED: 503 while MARKET_SHIFT_CRON_SECRET is unset or under 32 characters; 401 on any mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["MARKET_SHIFT_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Market-shift alerts are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ counts: await runMarketShiftAlerts(getDb(), getDeps().now()) });
}

export const POST = withApi(handlePost);
