import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { reviewDisclosurePg } from "../../../../../src/server/disclosure-config-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Verify (the item now counts for publishing) or reject (the owner must answer again) a submission. Body { decision, reason }. */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "disclosure.verify");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  const decision = b?.["decision"];
  const reason = typeof b?.["reason"] === "string" ? (b["reason"] as string).trim() : "";
  if (decision !== "verify" && decision !== "reject") return fail(400, "Decision must be verify or reject.");
  if (reason.length < 10 || reason.length > 1000) return fail(400, "Give a reason of 10 to 1000 characters.");
  const { id } = await ctx.params;
  const r = await reviewDisclosurePg(getDb(), id, staff.id, decision, reason);
  if (r.outcome === "not_found") return fail(404, "Submission not found.");
  if (r.outcome === "already_reviewed") return fail(409, "This submission was already reviewed.");
  if (r.outcome === "own_listing") return fail(403, "You can't review a disclosure on your own listing or one you submitted.");
  await staffAudit(staff, "listing", r.listingId!, decision === "verify" ? "staff.disclosure_verified" : "staff.disclosure_rejected", { submissionId: id, key: r.key, reason });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
