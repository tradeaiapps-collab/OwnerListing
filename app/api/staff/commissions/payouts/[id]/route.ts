import { NextResponse } from "next/server";
import { markPayoutPaid } from "../../../../../../src/server/commission-db";
import { getDb } from "../../../../../../src/server/context";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Confirms a scheduled payment was paid to the agent outside the platform. Body: { reference?: string }. The deal must be earned. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "commission.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Payout not found.");
  const body = (await readJsonObject(req)) ?? {};
  const ref = typeof body["reference"] === "string" ? body["reference"].trim() : "";
  if (ref.length > 100 || /[\u0000-\u001f\u007f<>]/.test(ref)) return fail(400, "The reference is at most 100 plain characters.");
  const r = await markPayoutPaid(getDb(), staff, id, ref || null);
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const POST = withApi(handlePost);
