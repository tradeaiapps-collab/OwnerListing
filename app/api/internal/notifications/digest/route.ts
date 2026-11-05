import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runDigests } from "../../../../../src/server/notification-digest";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Hourly worker tick for the daily digest, called by a scheduler (not by browsers) with header x-cron-secret.
 * FAILS CLOSED: 503 while ALERT_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (compared as SHA-256 digests in constant time).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["ALERT_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Digest worker is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ counts: await runDigests(getDb(), process.env, new Date().toISOString()) });
}

export const POST = withApi(handlePost);
