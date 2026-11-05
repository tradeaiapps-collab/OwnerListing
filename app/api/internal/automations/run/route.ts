import { NextResponse } from "next/server";
import { runDueAutomations } from "../../../../../src/server/automation-db";
import { authorizeCron } from "../../../../../src/server/cron-secret-db";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Tick for automation runs whose wait is over, called by a scheduler (not by browsers) with header x-cron-secret, every 10 minutes or so.
 * FAILS CLOSED: 503 while the job is paused or has no secret (stored in /staff/cron-secrets, else the environment variable, 32+ chars); 401 on any mismatch.
 */
async function handlePost(req: Request) {
  const auth = await authorizeCron(getDb(), "automations", req.headers.get("x-cron-secret"));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json(await runDueAutomations(getDb(), new Date().toISOString()));
}

export const POST = withApi(handlePost);
