import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runAccountRetention } from "../../../../../src/server/account-deletion-db";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Daily retention tick for deleted accounts, called by a scheduler (not by browsers) with header x-cron-secret. Makes deletions final
 * once their recovery window has passed, and clears name, email, Google link and phone after the 7-year retention period.
 * FAILS CLOSED: 503 while ACCOUNT_RETENTION_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["ACCOUNT_RETENTION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Account retention job is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const counts = await runAccountRetention(getDb(), new Date().toISOString());
  return NextResponse.json({ counts });
}

export const POST = withApi(handlePost);
