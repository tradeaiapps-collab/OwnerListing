import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runDueFeeds } from "../../../../../src/server/property-feed-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Scheduler tick for property data feeds (.github/workflows/property-feeds.yml calls it hourly; each connection runs when due).
 * FAILS CLOSED: 503 while FEED_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (SHA-256 digests, constant time).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["FEED_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Feed worker is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const runs = await runDueFeeds(getDb(), fetch, process.env, new Date().toISOString());
  return NextResponse.json({ runs: runs.map(r => ({ connectionId: r.connectionId, status: r.status, created: r.created, updated: r.updated, events: r.events, error: r.error })) });
}

export const POST = withApi(handlePost);
