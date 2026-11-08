import { NextResponse } from "next/server";
import { parseOverride, parseSchedule } from "../../../../../src/domain/commission";
import { REASON_ERROR, reasonOk } from "../../../../../src/domain/staff-admin";
import { getDeal, overrideDeal, replaceSchedule, setDealStatus } from "../../../../../src/server/commission-db";
import { getDb } from "../../../../../src/server/context";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "commission.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Deal not found.");
  const d = await getDeal(getDb(), id);
  return d ? NextResponse.json(d, { headers: { "cache-control": "no-store" } }) : fail(404, "Deal not found.");
}

/**
 * Body: { action: "override", overrideCents: number | null, reason } | { action: "earned" } | { action: "cancel", reason }
 * | { action: "schedule", payments: [{ dueDate, amountCents }] }. Overrides and cancellations need a reason; everything is logged.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "commission.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Deal not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send the action.");
  const db = getDb();
  let r;
  switch (body["action"]) {
    case "override": {
      const o = parseOverride(body);
      if (!o.ok) return fail(400, o.error);
      r = await overrideDeal(db, staff, id, o.value.overrideCents, o.value.reason);
      break;
    }
    case "earned": r = await setDealStatus(db, staff, id, "earned", null); break;
    case "cancel":
      if (!reasonOk(body["reason"])) return fail(400, REASON_ERROR);
      r = await setDealStatus(db, staff, id, "cancelled", body["reason"].trim());
      break;
    case "schedule": {
      const shaped = parseSchedule(body["payments"], null);
      if (!shaped.ok) return fail(400, shaped.error);
      r = await replaceSchedule(db, staff, id, shaped.value);
      break;
    }
    default: return fail(400, "Unknown action.");
  }
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
