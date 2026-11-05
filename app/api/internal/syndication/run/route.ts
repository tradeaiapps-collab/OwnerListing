import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runCalendarImports, runSyndication, syndicationDeps } from "../../../../../src/server/syndication-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Worker tick for listing syndication (push new and changed listings, retry failures, de-list what is no longer published, import portal calendars), called by a scheduler
 * with header x-cron-secret. FAILS CLOSED: 503 while SYNDICATION_CRON_SECRET is unset or under 32 characters; 401 on any mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["SYNDICATION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Syndication worker is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const deps = syndicationDeps();
  return NextResponse.json({ counts: await runSyndication(getDb(), deps), calendars: await runCalendarImports(getDb(), deps) });
}

export const POST = withApi(handlePost);
