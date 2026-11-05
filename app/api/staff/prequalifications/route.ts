import { NextResponse } from "next/server";
import type { PrequalStatus } from "../../../../src/domain/prequalification";
import { getDb, getDeps } from "../../../../src/server/context";
import { bulkVerify, staffQueue } from "../../../../src/server/prequalification-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const STATUSES: readonly string[] = ["pending_review", "verified", "resubmit_requested", "expired"];

/** Pre-approval queue (masked buyer names) and offers whose buyer has none. Optional ?status= filter. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "prequal.review");
  if (staff instanceof NextResponse) return staff;
  const status = new URL(req.url).searchParams.get("status");
  if (status !== null && !STATUSES.includes(status)) return fail(400, "Unknown status.");
  const data = await staffQueue(getDb(), (status as PrequalStatus | null) ?? undefined, getDeps().now());
  await staffAudit(staff, "staff_session", staff.id, "prequal.queue_viewed", { rows: data.rows.length });
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}

/** Bulk: { action: "verify", ids }. Verifies only letters Elena read cleanly (amount and expiry found, confidence not low); the rest stay pending. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "prequal.review");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const ids = body?.["ids"];
  if (body?.["action"] !== "verify" || !Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every(i => typeof i === "string" && UUID_RE.test(i))) {
    return fail(400, "Send { action: \"verify\", ids: [1 to 50 ids] }.");
  }
  const now = getDeps().now();
  const r = await bulkVerify(getDb(), staff, [...new Set(ids as string[])], now, now.slice(0, 10));
  return NextResponse.json(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
