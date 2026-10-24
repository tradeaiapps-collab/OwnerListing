import { NextResponse } from "next/server";
import { ID_CLAIM_TTL_MS } from "../../../../../../src/domain/id-image";
import { reviewSubmission, type ReviewChecklist, type ReviewOutcome } from "../../../../../../src/domain/id-verification";
import { REASON_ERROR, reasonOk } from "../../../../../../src/domain/staff-admin";
import { approvalBlocker } from "../../../../../../src/server/id-image";
import { getIdImageDeps } from "../../../../../../src/server/verification-context";
import { getDb } from "../../../../../../src/server/context";
import { getIdSubmission, saveIdReview } from "../../../../../../src/server/staff-admin-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";

const OUTCOMES: readonly string[] = ["approve", "reject", "needs_more"];
const STATUS_CHECKS = ["done", "not_available", "failed"] as const;

function parseChecklist(v: unknown): ReviewChecklist {
  const o = (v !== null && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const status = STATUS_CHECKS.find(s => s === o["officialStatusCheck"]);
  return {
    documentLooksGenuine: o["documentLooksGenuine"] === true, photoMatchesSelfie: o["photoMatchesSelfie"] === true,
    nameMatchesAccount: o["nameMatchesAccount"] === true, notExpired: o["notExpired"] === true,
    ...(status ? { officialStatusCheck: status } : {})
  };
}

/**
 * One reviewer's decision on an identity check. Approval needs image storage configured, the reviewer's live claim and
 * every image opened under that claim (approvalBlocker). A reviewer cannot review their own check; every decision needs a reason.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "identity.review");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Invalid JSON body.");
  const outcome = body["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) return fail(400, "Outcome must be approve, reject or needs_more.");
  if (!reasonOk(body["reason"])) return fail(400, REASON_ERROR);
  const { id } = await ctx.params;
  const db = getDb();
  const before = UUID_RE.test(id) ? await getIdSubmission(db, id) : null;
  if (!before) return fail(404, "Submission not found.");
  if (before.userId === staff.id) return fail(403, "Staff cannot review their own identity check.");
  if (outcome === "approve") {
    const blocker = await approvalBlocker(getIdImageDeps(), staff.id, id);
    if (blocker) return fail(409, blocker);
  }
  const checklist = parseChecklist(body["checklist"]);
  let after;
  try {
    after = reviewSubmission(before, staff, outcome as ReviewOutcome, checklist, new Date().toISOString());
  } catch (e) {
    return fail(409, e instanceof Error ? e.message : "Review not allowed.");
  }
  if (!(await saveIdReview(db, before, after, { staffId: staff.id, claimTtlMs: ID_CLAIM_TTL_MS }))) {
    return fail(409, "This submission changed, your claim ended or another reviewer holds it; reload it.");
  }
  await staffAudit(staff, "id_submission", id, "staff.id_reviewed", { outcome, resultingStatus: after.status, checklist, reason: (body["reason"] as string).trim() });
  return NextResponse.json({ ok: true, status: after.status });
}
