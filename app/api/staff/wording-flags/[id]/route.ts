import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../../src/server/staff-route";
import { reviewWordingFlagPg } from "../../../../../src/server/wording-flags-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Clear (a lawful exception: that exact match may publish on that listing) or uphold (stays blocked) an open flag.
 * Body: { decision: "clear" | "uphold", reason } with a reason of 10 to 1000 characters. Logged in the audit trail.
 */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "wording.review");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  const decision = b?.["decision"];
  const reason = typeof b?.["reason"] === "string" ? (b["reason"] as string).trim() : "";
  if (decision !== "clear" && decision !== "uphold") return fail(400, "Decision must be clear or uphold.");
  if (reason.length < 10 || reason.length > 1000) return fail(400, "Give a reason of 10 to 1000 characters.");
  const { id } = await ctx.params;
  const r = await reviewWordingFlagPg(getDb(), id, staff.id, decision, reason);
  if (r.outcome === "not_found") return fail(404, "Flag not found.");
  if (r.outcome === "already_reviewed") return fail(409, "This flag was already reviewed.");
  if (r.outcome === "own_flag") return fail(403, "You raised this flag, so someone else must review it.");
  await staffAudit(staff, "listing", r.listingId!, decision === "clear" ? "staff.wording_flag_cleared" : "staff.wording_flag_upheld", { flagId: id, reason });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
