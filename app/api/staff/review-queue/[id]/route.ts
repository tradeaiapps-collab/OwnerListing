import { NextResponse } from "next/server";
import { planDecision } from "../../../../../src/domain/moderation-queue";
import { getDb } from "../../../../../src/server/context";
import { decideQueueItemPg, getQueueTargetPg } from "../../../../../src/server/moderation-queue-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { "decision": "approve" | "reject" | "escalate", "reason": text (10+ characters) }. The decision and its audit event commit together. */
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
  if (!(await decideQueueItemPg(db, id, staff, plan.decision, plan.from, plan.note))) return fail(409, "Someone else already decided this item.");
  return NextResponse.json({ ok: true, status: plan.to });
}

export const POST = withApi(handlePost);
