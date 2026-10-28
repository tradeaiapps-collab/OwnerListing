import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { planListingAction } from "../../../../../../src/domain/admin-moderation";
import { evaluateListingPublish } from "../../../../../../src/domain/listing-service";
import { transitionListing } from "../../../../../../src/domain/listing-transitions";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { moderateListing } from "../../../../../../src/server/admin-moderation-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body { action: "suspend" | "reinstate" | "send_back", reason }. Reinstating re-runs the publish gate on the owner's behalf and is
 * refused with its reasons if the listing would not pass today. The status change and the audit event commit together.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "listing.moderate");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Listing not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec) return fail(404, "Listing not found.");
  const plan = planListingAction(staff, rec.listing.status, body["action"], body["reason"]);
  if (plan.action === "deny") return fail(plan.status, plan.error);

  const now = deps.now();
  let decision;
  if (plan.needsPublishGate) {
    decision = await evaluateListingPublish(deps, rec, now, rec.listing.ownerUserId);
    if (!decision.allowed) return NextResponse.json({ error: "This listing would not pass the publish checks today.", reasons: decision.reasons }, { status: 409 });
  }
  // The domain transition enforces the allowed moves (and the publish decision); the event it returns is what gets audited.
  const { event } = transitionListing(rec.listing, plan.to, { eventId: randomUUID(), correlationId: randomUUID(), actorType: "user", actorId: staff.id, now }, decision);
  const ok = await moderateListing(getDb(), id, plan.from, plan.to, {
    ...event, payload: { ...event.payload, role: staff.role, action: plan.action, reason: plan.reason, moderation: true }
  });
  if (!ok) return fail(409, "This listing changed in the meantime. Reload and try again.");
  return NextResponse.json({ ok: true, status: plan.to });
}

export const POST = withApi(handlePost);
