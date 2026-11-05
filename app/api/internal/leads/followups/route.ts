import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runLeadFollowUps } from "../../../../../src/domain/lead-service";
import { getDb } from "../../../../../src/server/context";
import { createFollowUpSender, getLeadDeps, purgeOldLeadText } from "../../../../../src/server/lead-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Lead follow-up tick, called by a scheduler with header x-cron-secret, ideally every 15 minutes: closes idle chats, sends Elena's check-ins (at most two,
 * 8am to 8pm local, only to people who texted or emailed first), flags agents who have not made first contact, and deletes old conversation text.
 * FAILS CLOSED: 503 while LEAD_CRON_SECRET is unset or under 32 characters or LEAD_QUALIFIER is not on; 401 on a mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["LEAD_CRON_SECRET"];
  if (process.env["LEAD_QUALIFIER"] !== "on" || !secret || secret.length < 32) return NextResponse.json({ error: "Lead follow-ups are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const db = getDb();
  const result = await runLeadFollowUps(await getLeadDeps(db), createFollowUpSender(db));
  return NextResponse.json({ ...result, purged: await purgeOldLeadText(db) });
}

export const POST = withApi(handlePost);
