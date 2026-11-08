import { NextResponse } from "next/server";
import { parseNewHolding } from "../../../../src/domain/deposit-escrow";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb } from "../../../../src/server/context";
import { createHolding, overview, pendingReleases } from "../../../../src/server/deposit-escrow-db";
import { fail, readJsonObject, staffAudit, staffGate, staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Deposit records with their ledgers, accepted offers still without a record, trust accounts in use, and requests waiting for approval. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["escrow.manage", "escrow.approve"]);
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const [data, pending] = await Promise.all([overview(db), pendingReleases(db)]);
  await staffAudit(staff, "staff_session", staff.id, "escrow.viewed", { holdings: data.holdings.length });
  return NextResponse.json(
    { ...data, pending, me: staff.id, can: { manage: staffCan(staff, "escrow.manage"), approve: staffCan(staff, "escrow.approve") } },
    { headers: { "cache-control": "no-store" } }
  );
}

/** Opens the deposit record for an accepted offer, in the listing's approved solicitor trust account. Body: { offerId, requiredCents?, dueDate? }. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "escrow.manage");
  if (staff instanceof NextResponse) return staff;
  const input = parseNewHolding(await readJsonObject(req));
  if (!input.ok) return fail(400, input.error);
  const r = await createHolding(getDb(), staff, input.value);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
