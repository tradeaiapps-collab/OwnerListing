import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { runJob, stalledJobIds } from "../../../../../src/server/listing-bulk-db";
import { bulkIo } from "../../../../../src/server/listing-bulk-io";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Scheduler tick (every minute or so, header x-cron-secret): finishes bulk listing runs whose worker stopped. Only needed when a deploy
 * or restart interrupts a run; the staff screen also re-starts a stalled run while it is open.
 * FAILS CLOSED: 503 while LISTING_BULK_CRON_SECRET is unset or under 32 characters; 401 on any mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["LISTING_BULK_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Bulk listing job is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const db = getDb();
  const ids = await stalledJobIds(db);
  for (const id of ids) await runJob(db, bulkIo(), id);
  return NextResponse.json({ resumed: ids.length });
}

export const POST = withApi(handlePost);
