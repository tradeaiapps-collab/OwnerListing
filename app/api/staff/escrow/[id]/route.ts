import { NextResponse } from "next/server";
import { parseReceipt, parseReleaseRequest } from "../../../../../src/domain/deposit-escrow";
import { parseResolution } from "../../../../../src/domain/sale-fall-through";
import { REASON_ERROR, reasonOk } from "../../../../../src/domain/staff-admin";
import { getDb } from "../../../../../src/server/context";
import { cancelHolding, getHolding, recordReceipt, requestRelease } from "../../../../../src/server/deposit-escrow-db";
import { requestCasePayout, resolveDispute } from "../../../../../src/server/sale-fall-through-db";
import { fail, readJsonObject, staffGate, staffGateAny, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** One deposit record: its ledger, release requests and audit trail. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGateAny(req, ["escrow.manage", "escrow.approve"]);
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Deposit record not found.");
  const d = await getHolding(getDb(), id);
  return d ? NextResponse.json(d, { headers: { "cache-control": "no-store" } }) : fail(404, "Deposit record not found.");
}

/**
 * Body: { action: "receipt", amountCents, receivedOn, bankReference? } | { action: "request", kind: "release" | "refund", amountCents, reason,
 * settlementConfirmed } | { action: "cancel", reason } | { action: "case_resolve", caseId, source, reference?, refundCents?, releaseCents?, reason } (after a
 * dispute) | { action: "case_payout", caseId } (the next refund or release of an agreed sale-fell-through case, pre-filled). Every step is logged; a payout needs a second person (see releases/[id]).
 */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "escrow.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Deposit record not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send the action.");
  const db = getDb();
  let r;
  switch (body["action"]) {
    case "receipt": {
      const input = parseReceipt(body, new Date().toISOString().slice(0, 10));
      if (!input.ok) return fail(400, input.error);
      r = await recordReceipt(db, staff, id, input.value);
      break;
    }
    case "request": {
      const input = parseReleaseRequest(body);
      if (!input.ok) return fail(400, input.error);
      r = await requestRelease(db, staff, id, input.value);
      break;
    }
    case "cancel":
      if (!reasonOk(body["reason"])) return fail(400, REASON_ERROR);
      r = await cancelHolding(db, staff, id, body["reason"].trim());
      break;
    case "case_resolve": case "case_payout": {
      const caseId = body["caseId"];
      if (typeof caseId !== "string" || !UUID_RE.test(caseId)) return fail(400, "Choose the case.");
      if (body["action"] === "case_payout") { r = await requestCasePayout(db, staff, caseId); break; }
      const held = (await getHolding(db, id))?.movements.reduce((s, m) => s + (m.kind === "receipt" ? m.amountCents : -m.amountCents), 0) ?? 0;
      const input = parseResolution(body, held);
      if (!input.ok) return fail(400, input.error);
      r = await resolveDispute(db, staff, caseId, input.value);
      break;
    }
    default: return fail(400, "Unknown action.");
  }
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
