import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runDueReports } from "../../../../../src/server/saved-reports-run";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Hourly tick for scheduled reports, called by a scheduler (not by browsers) with header x-cron-secret. Runs every schedule that is due
 * and emails the report to its owner. Safe to repeat: a schedule is claimed before it runs, so nothing is sent twice.
 * FAILS CLOSED: 503 while REPORTS_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["REPORTS_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Scheduled reports are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const counts = await runDueReports(getDb(), new Date().toISOString(), process.env);
  return NextResponse.json({ counts });
}

export const POST = withApi(handlePost);
