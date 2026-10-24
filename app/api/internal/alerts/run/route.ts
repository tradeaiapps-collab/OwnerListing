import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runAlertOutbox } from "../../../../../src/server/alert-outbox-db";
import { getDb } from "../../../../../src/server/context";
import { alertDeliveryFor } from "../../../../../src/server/messaging";

/**
 * Worker tick for the alert outbox, called by a scheduler (not by browsers) with header x-cron-secret.
 * FAILS CLOSED: 503 while ALERT_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (compared as SHA-256 digests in constant time).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function POST(req: Request) {
  const secret = process.env["ALERT_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Alert worker is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const counts = await runAlertOutbox(getDb(), alertDeliveryFor(getDb(), process.env), process.env, new Date().toISOString());
  return NextResponse.json({ counts });
}
