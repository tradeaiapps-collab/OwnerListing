import { NextResponse } from "next/server";
import { ID_CLAIM_TTL_MS } from "../../../../../../src/domain/id-image";
import { failure } from "../../../../../../src/server/http";
import { claimIdSubmission } from "../../../../../../src/server/id-image";
import { fail, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { getIdImageDeps } from "../../../../../../src/server/verification-context";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Assigns the check (and image access) to this reviewer for 30 minutes. Not their own check, not one they already approved, not one someone else holds. */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "identity.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Submission not found.");
  const r = await claimIdSubmission(getIdImageDeps(), staff.id, id, ID_CLAIM_TTL_MS);
  if (!r.ok) return failure(r);
  await staffAudit(staff, "id_submission", id, "staff.id_claimed", {});
  return NextResponse.json({ ok: true, expiresInMinutes: ID_CLAIM_TTL_MS / 60000 });
}

export const POST = withApi(handlePost);
