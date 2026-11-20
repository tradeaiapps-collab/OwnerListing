import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { runJobReminders } from "../../../../src/server/contractor-ops-notify";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Reminder tick for upcoming confirmed jobs, called by a scheduler (not by browsers) with header x-cron-secret, ideally hourly.
 * FAILS CLOSED: 503 while JOB_REMINDER_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["JOB_REMINDER_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Job reminders are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runJobReminders(getDb(), new Date().toISOString()));
}

export const POST = withApi(handlePost);
