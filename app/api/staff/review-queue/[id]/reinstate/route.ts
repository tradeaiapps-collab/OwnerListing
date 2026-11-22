import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { evaluateListingPublish } from "../../../../../../src/domain/listing-service";
import { transitionListing } from "../../../../../../src/domain/listing-transitions";
import { planReinstate } from "../../../../../../src/domain/moderation-queue";
import { userTarget } from "../../../../../../src/server/admin-moderation-db";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { republishSuspended } from "../../../../../../src/server/listing-reinstate";
import { getQueueTargetPg, getSuspensionPg, reinstateQueueItemPg, SuspensionConflict } from "../../../../../../src/server/moderation-queue-db";
import { listingsSuspendedWithAccount } from "../../../../../../src/server/admin-moderation-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body { reason (10+ characters), listings?: "reinstate" | "keep" }. Lifts the suspension a rejection from this queue made (the listing, or
 * the account), once. A listing goes live again only if it passes the publish checks today. Logged with the staff member's reason.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "moderation.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const body = await readJsonObject(req);
  const db = getDb();
  const item = await getQueueTargetPg(db, id);
  if (!item) return fail(404, "Not found.");
  const { suspension, reinstated } = await getSuspensionPg(db, id);
  const deps = getDeps();
  const rec = suspension?.kind === "listing" && suspension.listingId ? await deps.repo.get(suspension.listingId) : undefined;
  const facts = suspension?.kind === "listing" ? { listingStatus: rec?.listing.status }
    : suspension?.userId ? { user: (await userTarget(db, suspension.userId)) ?? undefined } : {};
  const plan = planReinstate(staff, item, suspension, reinstated, body, facts);
  if ("action" in plan) return fail(plan.status, plan.error);

  let listingEvent;
  if (plan.kind === "listing" && rec) {
    const now = deps.now();
    const decision = await evaluateListingPublish(deps, rec, now, rec.listing.ownerUserId);
    if (!decision.allowed) return NextResponse.json({ error: "This listing would not pass the publish checks today.", reasons: decision.reasons }, { status: 409 });
    const { event } = transitionListing(rec.listing, "published", { eventId: randomUUID(), correlationId: randomUUID(), actorType: "user", actorId: staff.id, now }, decision);
    listingEvent = { ...event, payload: { ...event.payload, role: staff.role, action: "reinstate", reason: plan.reason, moderation: true, moderationItem: id } };
  }
  try {
    if (!(await reinstateQueueItemPg(db, id, staff, plan, listingEvent))) return fail(409, "Already reinstated.");
  } catch (e) {
    if (e instanceof SuspensionConflict) return fail(409, "The listing or account changed in the meantime, so nothing was changed. Reload and try again.");
    throw e;
  }
  if (plan.kind === "listing") return NextResponse.json({ ok: true, reinstated: "listing" });
  if (!plan.withListings) return NextResponse.json({ ok: true, reinstated: "account", listingsRestored: 0, listingsNotRestored: [] });
  const { restored, notRestored } = await republishSuspended(staff, await listingsSuspendedWithAccount(db, plan.userId),
    { action: "reinstate", reason: plan.reason, moderation: true, withAccount: plan.userId, moderationItem: id });
  return NextResponse.json({ ok: true, reinstated: "account", listingsRestored: restored, listingsNotRestored: notRestored });
}

export const POST = withApi(handlePost);
