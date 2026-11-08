import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runCrmSync } from "../../../../../src/server/crm-sync-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Scheduler tick for status sync back to agency CRMs (called right after the feed run by .github/workflows/property-feeds.yml).
 * Uses the same secret as the feed worker. FAILS CLOSED: 503 while FEED_CRON_SECRET is unset or under 32 characters; 401 on mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["FEED_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Feed worker is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runCrmSync(getDb()));
}

export const POST = withApi(handlePost);
