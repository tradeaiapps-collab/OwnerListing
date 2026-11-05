import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueReports } from "../../../../../src/domain/agent-reports";
import { getReportDeps } from "../../../../../src/server/agent-reports-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Hourly tick for scheduled agent reports, called by a scheduler (not by browsers) with header x-cron-secret. Emails each due report to
 * its agent's own address. FAILS CLOSED: 503 while AGENT_REPORT_CRON_SECRET is unset or under 32 characters; 401 on any mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["AGENT_REPORT_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Scheduled reports are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ counts: await runDueReports(getReportDeps(), process.env["APP_URL"]) });
}

export const POST = withApi(handlePost);
