import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueAutomations } from "../../../../../src/server/automation-db";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Tick for automation runs whose wait is over, called by a scheduler (not by browsers) with header x-cron-secret, every 10 minutes or so.
 * FAILS CLOSED: 503 while AUTOMATION_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["AUTOMATION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Automations are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runDueAutomations(getDb(), new Date().toISOString()));
}

export const POST = withApi(handlePost);
