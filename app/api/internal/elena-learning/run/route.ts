import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb, getDeps } from "../../../../../src/server/context";
import { proposeMonthlyConfigPg, refreshUserPatternsPg, syncSettlementOutcomesPg } from "../../../../../src/server/elena-learning-db";
import { sweepImpliedReactionsPg } from "../../../../../src/server/elena-wiring-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Elena's learning jobs, called by a scheduler with header x-cron-secret. Body { "job": "weekly" | "monthly" }.
 *  weekly: record newly finished deals and refresh each consenting person's pattern.
 *  monthly: also learn from the last 180 days and store a PROPOSED version; staff activate it at /staff/elena-training.
 * FAILS CLOSED: 503 while ELENA_LEARNING_CRON_SECRET is unset or under 32 characters; 401 on any mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["ELENA_LEARNING_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Elena learning is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const job = ((await req.json().catch(() => ({}))) as { job?: unknown }).job;
  if (job !== "weekly" && job !== "monthly") return NextResponse.json({ error: "job must be weekly or monthly." }, { status: 400 });
  const db = getDb(), now = new Date(getDeps().now());
  const outcomes = await syncSettlementOutcomesPg(db);
  const implied = await sweepImpliedReactionsPg(db);
  const patterns = await refreshUserPatternsPg(db, now);
  const proposal = job === "monthly" ? await proposeMonthlyConfigPg(db, now) : undefined;
  return NextResponse.json({ outcomes, implied, patterns, proposedVersion: proposal?.version ?? null });
}

export const POST = withApi(handlePost);
