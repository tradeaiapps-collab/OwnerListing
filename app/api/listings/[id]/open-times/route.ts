import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { publishTime, repo, scheduleFor } from "../../../../../src/server/open-inspection-service";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The open inspection times published for a listing the signed-in owner or appointed agent manages: weekly and one-off windows, and blocked times. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await scheduleFor(repo(), actor, (await params).id);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Body: `{ type: "rule", recurrence: "weekly" | "once", dayOfWeek | date, start, end, slotMinutes, capacity?, endDate? }` or `{ type: "block", startsAt, endsAt, note? }`. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await publishTime(repo(), actor, (await params).id, await req.json().catch(() => null), new Date().toISOString());
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
