import { NextResponse } from "next/server";
import { getDb } from "../../../../../../src/server/context";
import { decideRelease } from "../../../../../../src/server/deposit-escrow-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { requireRecentStaffMfa } from "../../../../../../src/server/mfa-context";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Second person approves or rejects a release or refund. Body: { outcome: "approve" | "reject", reason }. The requester cannot decide. Approving needs a recent MFA check. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "escrow.approve");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Request not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send the decision.");
  // Approving moves money: it needs a second-factor check in the last 15 minutes (rejecting does not).
  if (body["outcome"] === "approve") {
    const stale = await requireRecentStaffMfa(req);
    if (stale) return stale;
  }
  const r = await decideRelease(getDb(), staff, id, body["outcome"], body["reason"]);
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const POST = withApi(handlePost);
