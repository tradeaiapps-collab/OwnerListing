import { NextResponse } from "next/server";
import { nextStatus, parseFindings, plainText, LIMITS, type InspectionAction } from "../../../../src/domain/inspection";
import { getDb, getDeps } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { inspectionById, moveInspection } from "../../../../src/server/transaction-db";
import { audit, readJson, requireTxnAccess, UUID_RE } from "../../../../src/server/transaction-http";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const ACTIONS: readonly InspectionAction[] = ["confirm", "cancel", "complete"];

/**
 * Body: { action: "confirm" | "cancel" | "complete", reason?, findings? }. The inspector confirms and completes (with findings);
 * the owner, agent, inspector or the named buyer can cancel. A walkthrough without an inspector is handled by the owner or agent.
 */
async function handlePatch(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const id = (await params).id;
  const db = getDb();
  const insp = UUID_RE.test(id) ? await inspectionById(db, id) : undefined;
  if (!insp) return NextResponse.json({ error: "Inspection not found." }, { status: 404 });
  const a = await requireTxnAccess(req, insp.listingId);
  if (a instanceof NextResponse) return a;
  const involved = a.role === "owner" || a.role === "agent" || insp.inspectorUserId === a.actor.userId || insp.buyerUserId === a.actor.userId;
  if (!involved) return NextResponse.json({ error: "Inspection not found." }, { status: 404 });
  const body = await readJson(req, 60_000);
  if (body instanceof NextResponse) return body;
  const action = body["action"];
  if (typeof action !== "string" || !ACTIONS.includes(action as InspectionAction)) return NextResponse.json({ error: "Choose confirm, cancel or complete." }, { status: 400 });
  const role = insp.inspectorUserId === a.actor.userId ? "inspector" : a.role;
  const deps = getDeps();
  const step = nextStatus(insp, action as InspectionAction, role, deps.now(), insp.scheduledStart);
  if (!step.ok) return NextResponse.json({ error: step.message }, { status: 409 });
  const reason = plainText(body["reason"], LIMITS.reason, false);
  if (reason === undefined) return NextResponse.json({ error: `Reason can be up to ${LIMITS.reason} plain characters.` }, { status: 400 });
  const findings = action === "complete" ? parseFindings(body["findings"]) : { ok: true as const, value: [] };
  if (!findings.ok) return NextResponse.json({ error: findings.errors[0] }, { status: 400 });
  const moved = await moveInspection(db, id, insp.status, step.status, a.actor.userId, deps.now(), { reason: reason ?? undefined, findings: findings.value });
  if (!moved) return NextResponse.json({ error: "Someone else just changed this inspection. Reload and try again." }, { status: 409 });
  await audit(`inspection.${step.status}`, "inspection", id, a.actor.userId, { listingId: insp.listingId, findings: findings.value.length });
  return NextResponse.json({ inspection: moved });
}

export const PATCH = withApi(handlePatch);
