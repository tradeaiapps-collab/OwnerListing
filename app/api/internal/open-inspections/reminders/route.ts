import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runOpenInspectionReminders } from "../../../../../src/server/open-inspection-notify";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Reminder tick for open inspection bookings, called by a scheduler (not by browsers) with header x-cron-secret, every 15 minutes.
 * Sends the 24 hour and 1 hour reminders, each once per booking.
 * FAILS CLOSED: 503 while OPEN_INSPECTION_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["OPEN_INSPECTION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Inspection reminders are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runOpenInspectionReminders(getDb(), new Date().toISOString()));
}

export const POST = withApi(handlePost);
