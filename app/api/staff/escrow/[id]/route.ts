import { NextResponse } from "next/server";
import { parseReceipt, parseReleaseRequest } from "../../../../../src/domain/deposit-escrow";
import { REASON_ERROR, reasonOk } from "../../../../../src/domain/staff-admin";
import { getDb } from "../../../../../src/server/context";
import { cancelHolding, getHolding, recordReceipt, requestRelease } from "../../../../../src/server/deposit-escrow-db";
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
 * settlementConfirmed } | { action: "cancel", reason }. Every step is logged; a payout needs a second person (see releases/[id]).
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
    default: return fail(400, "Unknown action.");
  }
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
