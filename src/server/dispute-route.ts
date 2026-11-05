import { NextResponse } from "next/server";
import { isUuid } from "../domain/offer-decision";
import { MAX_TEXT, parseAction, parseCreate } from "../domain/dispute";
import { getActor, getDb } from "./context";
import { csrfGuard } from "./csrf";
import { createDispute, disputeView, listDisputes, respond, staffAct, staffQueue, staffView, submitPosition, withdraw, type Side, type StaffChange } from "./dispute-db";
import { unauthenticated } from "./http";
import { fail as staffFail, staffAudit, staffGate } from "./staff-route";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const NO_STORE = { "cache-control": "no-store" };
const obj = async (req: Request) => { const b: unknown = await req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null; };

/** GET /api/disputes?side=buyer|seller|agent: the disputes on the signed-in person's sales. */
export async function listGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const side = new URL(req.url).searchParams.get("side");
  if (side !== null && side !== "buyer" && side !== "seller" && side !== "agent") return fail(400, "side must be buyer, seller or agent.");
  return NextResponse.json({ disputes: await listDisputes(getDb(), actor.userId, side ? { side: side as Side } : {}) }, { headers: NO_STORE });
}

export async function settlementListGet(req: Request, settlementId: string) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(settlementId)) return fail(404, "Settlement not found.");
  return NextResponse.json({ disputes: await listDisputes(getDb(), actor.userId, { settlementId }) }, { headers: NO_STORE });
}

/** POST /api/settlements/[id]/disputes { type, title, description, position, claimCents?, sellerSharePct? } */
export async function createPost(req: Request, settlementId: string) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(settlementId)) return fail(404, "Settlement not found.");
  const input = parseCreate(await obj(req));
  if (!input.ok) return fail(400, input.error);
  const r = await createDispute(getDb(), actor.userId, settlementId, input.value);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : fail(r.status, r.error);
}

export async function viewGet(req: Request, settlementId: string, id: string) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(settlementId) || !isUuid(id)) return fail(404, "Dispute not found.");
  const r = await disputeView(getDb(), actor.userId, settlementId, id);
  return r.ok ? NextResponse.json(r.value, { headers: NO_STORE }) : fail(r.status, r.error);
}

/** POST /api/settlements/[id]/disputes/[did] { action: "position" | "respond" | "withdraw", ... } */
export async function actionPost(req: Request, settlementId: string, id: string) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!isUuid(settlementId) || !isUuid(id)) return fail(404, "Dispute not found.");
  const body = await obj(req);
  const db = getDb();
  const current = await disputeView(db, actor.userId, settlementId, id);
  if (!current.ok) return fail(current.status, current.error);
  const a = parseAction(body, current.value.claimCents !== null);
  if (!a.ok) return fail(400, a.error);
  const r = a.value.action === "position" ? await submitPosition(db, actor.userId, settlementId, id, a.value)
    : a.value.action === "respond" ? await respond(db, actor.userId, settlementId, id, a.value)
    : await withdraw(db, actor.userId, settlementId, id);
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

// ---------- staff ----------

export async function staffListGet(req: Request) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const q = await staffQueue(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.disputes_viewed", { returned: q.rows.length });
  return NextResponse.json(q, { headers: NO_STORE });
}

export async function staffViewGet(req: Request, id: string) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  if (!isUuid(id)) return staffFail(404, "Dispute not found.");
  const r = await staffView(getDb(), id);
  if (!r.ok) return staffFail(r.status, r.error);
  await staffAudit(staff, "dispute", id, "staff.dispute_viewed", {});
  return NextResponse.json(r.value, { headers: NO_STORE });
}

function parseStaff(b: Record<string, unknown> | null): { ok: true; value: StaffChange } | { ok: false; error: string } {
  if (!b) return { ok: false, error: "Send an action." };
  const text = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().length <= MAX_TEXT ? v.trim() : null);
  if (b["action"] === "claim") return { ok: true, value: { action: "claim" } };
  if (b["action"] === "note") { const n = text(b["note"]); return n ? { ok: true, value: { action: "note", note: n } } : { ok: false, error: "Write a note (up to 2000 characters)." }; }
  if (b["action"] === "resolve") {
    const outcome = text(b["outcome"]), share = b["sellerSharePct"];
    if (!outcome) return { ok: false, error: "Say in plain words how the dispute ends." };
    if (share !== undefined && share !== null && !(typeof share === "number" && Number.isInteger(share) && share >= 0 && share <= 100)) return { ok: false, error: "The seller's share must be a whole number from 0 to 100." };
    return { ok: true, value: { action: "resolve", outcome, sellerSharePct: typeof share === "number" ? share : null } };
  }
  return { ok: false, error: "Unknown action." };
}

/** POST /api/staff/disputes/[id] { action: "claim" } | { action: "note", note } | { action: "resolve", outcome, sellerSharePct? } */
export async function staffActionPost(req: Request, id: string) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  if (!isUuid(id)) return staffFail(404, "Dispute not found.");
  const a = parseStaff(await obj(req));
  if (!a.ok) return staffFail(400, a.error);
  const r = await staffAct(getDb(), staff.id, id, a.value);
  return r.ok ? NextResponse.json(r.value) : staffFail(r.status, r.error);
}
