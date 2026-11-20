import { NextResponse } from "next/server";
import { runDueAutomations } from "../../../../../src/server/automation-db";
import { runDueRentals } from "../../../../../src/server/elena-rentals-db";
import { runDueElenaJobs } from "../../../../../src/server/elena-jobs-db";
import { runDueSchedulingMessages } from "../../../../../src/server/elena-scheduling-db";
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
  const now = new Date().toISOString();
  const automations = await runDueAutomations(getDb(), now);
  // Elena's scheduling drafts ride on the same tick: due reminders become suggestions, stale drafts expire. Never fails the automation run.
  const scheduling = await runDueSchedulingMessages(getDb(), now).catch(() => ({ expired: 0, suggested: 0 }));
  // Contractor jobs Elena handles for owners who turned it on: new requests, reminders, time follow-ups and delivery chasing.
  const elenaJobs = await runDueElenaJobs(getDb(), now).catch(() => ({ created: 0, acted: 0, invited: 0 }));
  // Rentals: repair chasing, viewing reminders and viewing summaries for owners who switched Elena on.
  const rentals = await runDueRentals(getDb(), now).catch(() => ({ repairs: 0, reminders: 0, summaries: 0 }));
  return NextResponse.json({ ...automations, scheduling, elenaJobs, rentals });
}

export const POST = withApi(handlePost);
