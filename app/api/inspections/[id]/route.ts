import { NextResponse } from "next/server";
import { getReport, respondToInspection } from "../../../../src/domain/inspection";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getInspectionRepo, inspectionIds } from "../../../../src/server/inspection-db";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The report. What comes back depends on the caller's role; anyone with no role gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await getReport(getInspectionRepo(), actor, id);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "private, no-store" } }) : failure(r);
}

/**
 * Body: { action: "accept" | "decline" | "complete" } (inspector) or { action: "cancel" } or { action: "reschedule", scheduledAt } (owner or agent).
 * Only POST exists: inspections are never deleted.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await respondToInspection(getInspectionRepo(), actor, id, await req.json().catch(() => null), inspectionIds);
  return r.ok ? NextResponse.json({ inspection: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
