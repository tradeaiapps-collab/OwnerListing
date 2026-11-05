import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runQueueNow } from "../../../../../src/server/listing-video-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Video queue tick, called every few minutes by a scheduler with header x-cron-secret: submits queued videos, checks running ones,
 * retries failures and fails the ones past their deadline. FAILS CLOSED: 503 while VIDEO_CRON_SECRET is unset or under 32 characters; 401 on mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["VIDEO_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Video queue is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ counts: await runQueueNow(25) });
}
export const POST = withApi(handlePost);
