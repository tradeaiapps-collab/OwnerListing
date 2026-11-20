import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { deskFor, saveSettings } from "../../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { ok: false, code: "not_found", message: "Not found." } as const;

/** The owner's rentals desk for one rental listing: settings, applications compared side by side, viewing times, tenants and repairs. Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const desk = await deskFor(getDb(), actor.userId, id);
  return desk ? NextResponse.json(desk, { headers: { "cache-control": "private, no-store" } }) : failure(NOT_FOUND);
}

/** Body: { elenaOn, maxRentPct, minHistoryMonths, minReferences, moveInFrom?, moveInTo?, autoRepairOffers, autoEmergency }. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const r = await saveSettings(getDb(), actor.userId, id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ settings: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
