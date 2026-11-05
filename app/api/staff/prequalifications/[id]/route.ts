import { NextResponse } from "next/server";
import { parseReview } from "../../../../../src/domain/prequalification";
import { getDb, getDeps } from "../../../../../src/server/context";
import { reviewPrequal, staffDetail } from "../../../../../src/server/prequalification-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** One pre-approval with Elena's reading, for the review screen. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "prequal.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const d = await staffDetail(getDb(), id, getDeps().now());
  if (!d) return fail(404, "Not found.");
  await staffAudit(staff, "prequalification", id, "prequal.viewed", {});
  return NextResponse.json(d, { headers: { "cache-control": "no-store" } });
}

/** Decide: { action: "verify", approvedCents, expiresOn, conditions?, ratePercent?, termYears?, note? } or { action: "resubmit", note }. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "prequal.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const now = getDeps().now();
  const input = parseReview(await readJsonObject(req), now.slice(0, 10));
  if (!input.ok) return fail(400, input.error);
  const r = await reviewPrequal(getDb(), staff, id, input.value, now);
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
