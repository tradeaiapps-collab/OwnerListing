import { NextResponse } from "next/server";
import { getDb } from "../../../../../../src/server/context";
import { approveVersionPg } from "../../../../../../src/server/disclosure-config-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/**
 * Approves a drafted version: from now on it is the publish requirement for its combination and the previous approved version is
 * retired. Body { reason } (10 to 1000 characters, for example the counsel advice it rests on). Never the draft's author.
 */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "disclosure.config_approve");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  const reason = typeof b?.["reason"] === "string" ? (b["reason"] as string).trim() : "";
  if (reason.length < 10 || reason.length > 1000) return fail(400, "Give a reason of 10 to 1000 characters.");
  const { id } = await ctx.params;
  const r = await approveVersionPg(getDb(), id, staff.id, reason);
  if (!r.ok) return fail(r.status, r.error);
  await staffAudit(staff, "disclosure_config", id, "staff.disclosure_config_approved", { reason, retiredId: r.retiredId });
  return NextResponse.json({ ok: true, retiredId: r.retiredId });
}

export const POST = withApi(handlePost);
