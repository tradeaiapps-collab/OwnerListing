import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runAutomationTick } from "../../../../../src/server/staff-automation-run";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Tick for workflow rules, campaigns and scheduled tasks, called every 15 minutes by a scheduler (not by browsers) with header x-cron-secret.
 * Safe to repeat: everything is claimed before it runs. FAILS CLOSED: 503 while STAFF_AUTOMATION_CRON_SECRET is unset or under 32 characters; 401 on mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["STAFF_AUTOMATION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Staff automation is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ result: await runAutomationTick(getDb(), new Date().toISOString(), process.env) });
}

export const POST = withApi(handlePost);
