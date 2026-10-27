import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { planUserAction } from "../../../../../../src/domain/admin-moderation";
import { evaluateListingPublish } from "../../../../../../src/domain/listing-service";
import { transitionListing } from "../../../../../../src/domain/listing-transitions";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { listingsSuspendedWithAccount, moderateListing, setUserStatus, userTarget } from "../../../../../../src/server/admin-moderation-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body { action: "suspend" | "reinstate", reason, listings? }. A suspended account is refused from its next request. Audited with the change.
 * listings (chosen per case, see LISTING_CHOICES): suspending also suspends the account's live listings unless "keep"; reinstating brings
 * back the listings suspended with the account unless "keep", each only if it passes the publish checks today. The rest stay suspended
 * and are returned with the reasons.
 */
export async function POST(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Account not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const target = await userTarget(db, id);
  if (!target) return fail(404, "Account not found.");
  const plan = planUserAction(staff, target, body["action"], body["reason"], body["listings"]);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  const done = await setUserStatus(db, staff, id, plan.from, plan.to, plan.reason, { suspendListings: plan.action === "suspend" && plan.withListings });
  if (!done) return fail(409, "This account changed in the meantime. Reload and try again.");
  if (plan.action === "suspend") return NextResponse.json({ ok: true, status: plan.to, listingsSuspended: done.listingIds.length });
  if (!plan.withListings) return NextResponse.json({ ok: true, status: plan.to, listingsRestored: 0, listingsNotRestored: [] });

  // Each listing goes live again only through the publish gate, one at a time; a failure leaves that listing suspended.
  const deps = getDeps();
  let restored = 0;
  const notRestored: { id: string; title: string; reasons: string[] }[] = [];
  for (const listingId of await listingsSuspendedWithAccount(db, id)) {
    const rec = await deps.repo.get(listingId);
    if (!rec || rec.listing.status !== "suspended") continue;
    const now = deps.now();
    const decision = await evaluateListingPublish(deps, rec, now, rec.listing.ownerUserId);
    if (!decision.allowed) { notRestored.push({ id: listingId, title: rec.listing.title, reasons: decision.reasons }); continue; }
    const { event } = transitionListing(rec.listing, "published", { eventId: randomUUID(), correlationId: randomUUID(), actorType: "user", actorId: staff.id, now }, decision);
    const ok = await moderateListing(db, listingId, "suspended", "published", {
      ...event, payload: { ...event.payload, role: staff.role, action: "reinstate", reason: plan.reason, moderation: true, withAccount: id }
    });
    if (ok) restored++;
  }
  return NextResponse.json({ ok: true, status: plan.to, listingsRestored: restored, listingsNotRestored: notRestored });
}
