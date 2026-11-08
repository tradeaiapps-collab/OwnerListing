import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sendDueLeadReminders } from "../../../../../src/server/agent-lead-db";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Buyer-lead follow-up reminders, called by a scheduler with header x-cron-secret (hourly is plenty). Tells each agent once about every
 * follow-up that has come due. FAILS CLOSED: 503 while CRM_LEAD_CRON_SECRET is unset or under 32 characters; 401 on a mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["CRM_LEAD_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Lead reminders are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ reminded: await sendDueLeadReminders(getDb(), new Date().toISOString()) });
}

export const POST = withApi(handlePost);
