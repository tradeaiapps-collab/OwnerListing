import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runInviteReminders } from "../../../../../src/server/notifier";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Reminder tick for unanswered agent invitations, called by a scheduler (not by browsers) with header x-cron-secret, ideally hourly.
 * Each invitation open for 48 hours gets one reminder to the agent, on the channels they chose.
 * FAILS CLOSED: 503 while APPOINTMENT_REMINDER_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["APPOINTMENT_REMINDER_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Appointment reminders are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runInviteReminders(getDb(), new Date().toISOString()));
}

export const POST = withApi(handlePost);
