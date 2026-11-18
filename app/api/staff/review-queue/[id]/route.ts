import { NextResponse } from "next/server";
import { planDecision, planSuspension } from "../../../../../src/domain/moderation-queue";
import { getDb } from "../../../../../src/server/context";
import { userTarget } from "../../../../../src/server/admin-moderation-db";
import { decideQueueItemPg, getQueueTargetPg, rejectAndSuspendPg, SuspensionConflict } from "../../../../../src/server/moderation-queue-db";
import { getDeps } from "../../../../../src/server/context";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body: { "decision": "approve" | "reject" | "escalate", "reason": text (10+ characters) }. The decision and its audit event commit together.
 * Optional on reject: "suspend": "listing" | "account", "confirm": true, and for an account "listings": "suspend" | "keep". The suspension
 * follows the rules of the listing and user screens and commits in the same transaction as the decision.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "moderation.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const b = await readJsonObject(req);
  const db = getDb();
  const item = await getQueueTargetPg(db, id);
  if (!item) return fail(404, "Not found.");
  const plan = planDecision(staff, item, b?.["decision"], b?.["reason"]);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  const wants = b?.["suspend"] ?? "none";
  const facts = wants === "listing" && item.subjectType === "listing" && item.subjectId
    ? { listingStatus: (await getDeps().repo.get(item.subjectId))?.listing.status }
    : wants === "account" && item.subjectOwnerId ? { user: (await userTarget(db, item.subjectOwnerId)) ?? undefined } : {};
  const sus = planSuspension(staff, item, plan.decision, b, facts);
  if ("action" in sus) return fail(sus.status, sus.error);
  if (sus.kind === "none") {
    if (!(await decideQueueItemPg(db, id, staff, plan.decision, plan.from, plan.note))) return fail(409, "Someone else already decided this item.");
    return NextResponse.json({ ok: true, status: plan.to });
  }
  try {
    const r = await rejectAndSuspendPg(db, id, staff, plan.from, plan.note, sus);
    if (!r.decided) return fail(409, "Someone else already decided this item.");
    return NextResponse.json({ ok: true, status: plan.to, suspended: sus.kind, listingsSuspended: r.listingsSuspended });
  } catch (e) {
    if (e instanceof SuspensionConflict) return fail(409, "The listing or account changed in the meantime, so nothing was changed. Reload and try again.");
    throw e;
  }
}

export const POST = withApi(handlePost);
