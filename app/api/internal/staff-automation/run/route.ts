import { NextResponse } from "next/server";
import { authorizeCron } from "../../../../../src/server/cron-secret-db";
import { getDb } from "../../../../../src/server/context";
import { runAutomationTick } from "../../../../../src/server/staff-automation-run";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Tick for workflow rules, campaigns and scheduled tasks, called every 15 minutes by a scheduler (not by browsers) with header x-cron-secret.
 * Safe to repeat: everything is claimed before it runs. FAILS CLOSED: 503 while the job is paused or has no secret (stored in /staff/cron-secrets, else the environment variable, 32+ chars); 401 on any mismatch.
 */
async function handlePost(req: Request) {
  const auth = await authorizeCron(getDb(), "staff_automation", req.headers.get("x-cron-secret"));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ result: await runAutomationTick(getDb(), new Date().toISOString(), process.env) });
}

export const POST = withApi(handlePost);
