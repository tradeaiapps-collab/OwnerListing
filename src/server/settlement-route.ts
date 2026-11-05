import { NextResponse } from "next/server";
import { isUuid } from "../domain/offer-decision";
import { parseAction } from "../domain/settlement";
import { getActor, getDb } from "./context";
import { csrfGuard } from "./csrf";
import { unauthenticated } from "./http";
import { createSettlement, listSettlements, settlementView, tickChecklistItem, updateMilestone } from "./settlement-db";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const NO_STORE = { "cache-control": "no-store" };
const obj = async (req: Request) => { const b: unknown = await req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null; };

/** GET /api/settlements: the signed-in person's settlements (as buyer, owner or appointed agent), stuck ones first. */
export async function listGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ settlements: await listSettlements(getDb(), actor.userId) }, { headers: NO_STORE });
}

/** POST /api/settlements { offerId }: start tracking an accepted offer (owner or appointed agent). */
export async function startPost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = await obj(req);
  if (!b || !isUuid(b["offerId"])) return fail(400, "Send the offerId of an accepted offer.");
  const r = await createSettlement(getDb(), actor.userId, b["offerId"]);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : fail(r.status, r.error);
}

export async function viewGet(req: Request, id: string) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(id)) return fail(404, "Settlement not found.");
  const r = await settlementView(getDb(), actor.userId, id);
  return r.ok ? NextResponse.json(r.value, { headers: NO_STORE }) : fail(r.status, r.error);
}

/** POST /api/settlements/[id] { action: "milestone", stage, status?, targetDate?, actualDate?, note? } or { action: "tick", stage, role, itemId, done }. */
export async function actionPost(req: Request, id: string) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(id)) return fail(404, "Settlement not found.");
  const a = parseAction(await obj(req));
  if (!a.ok) return fail(400, a.error);
  const r = a.value.action === "tick" ? await tickChecklistItem(getDb(), actor.userId, id, a.value) : await updateMilestone(getDb(), actor.userId, id, a.value);
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}
