import { NextResponse } from "next/server";
import { listInspections, scheduleInspection } from "../../../../../src/domain/inspection";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getInspectionRepo, inspectionIds } from "../../../../../src/server/inspection-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Inspections booked on this listing, for the owner or appointed agent (others see only the ones they are part of). */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await listInspections(getInspectionRepo(), actor, id);
  return r.ok ? NextResponse.json({ inspections: r.value }) : failure(r);
}

/** Body: { type, scheduledAt, notes?, email | userId }. Owner or appointed agent books a registered inspector (vendor or agent account). */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await scheduleInspection(getInspectionRepo(), actor, id, await req.json().catch(() => null), inspectionIds);
  return r.ok ? NextResponse.json({ inspection: r.value }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
