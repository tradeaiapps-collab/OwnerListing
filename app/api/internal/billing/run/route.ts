import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readBrand } from "../../../../../src/config/brand";
import { getDb } from "../../../../../src/server/context";
import { getEmailPort } from "../../../../../src/server/messaging";
import { runBillingCycle } from "../../../../../src/server/subscription-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Daily billing tick, called by a scheduler (not by browsers) with header x-cron-secret: issues renewal invoices a week before a plan
 * ends, moves unpaid plans to past due and then expired, and emails payment reminders. It never charges anyone.
 * FAILS CLOSED: 503 while BILLING_RUN_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["BILLING_RUN_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "The billing run is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const db = getDb();
  const baseUrl = (() => { try { return new URL(process.env["APP_URL"] ?? "").origin; } catch { return ""; } })();
  const email = baseUrl ? await getEmailPort(db, process.env, "billing_reminder") : { configured: false, send: async () => ({ status: "not_configured" as const }) };
  const counts = await runBillingCycle(db, new Date().toISOString(), { email, siteName: readBrand().name, baseUrl });
  return NextResponse.json({ counts });
}

export const POST = withApi(handlePost);
