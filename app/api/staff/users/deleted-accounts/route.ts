import { NextResponse } from "next/server";
import { readBrand } from "../../../../../src/config/brand";
import { accountDeletedEmail, offerCancelledEmail, planAccountDeletion } from "../../../../../src/domain/account-deletion";
import { lookupEmail } from "../../../../../src/domain/mfa-reset";
import { deleteAccountPg, findDeletionTarget, listDeletedAccounts } from "../../../../../src/server/account-deletion-db";
import { deletionGate } from "../../../../../src/server/account-deletion-route";
import { getDb } from "../../../../../src/server/context";
import { sendNotice } from "../../../../../src/server/messaging";
import { fail, readJsonObject, staffAudit, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Without ?email: the deleted accounts, newest first (?cursor= pages). With ?email=: that account and what deleting it would touch
 * (listings to archive, offers to cancel, accepted offers left alone). Every lookup is audited, misses too.
 */
async function handleGet(req: Request) {
  const staff = await deletionGate(req);
  if (staff instanceof NextResponse) return staff;
  const params = new URL(req.url).searchParams;
  const db = getDb();
  if (!params.has("email")) {
    const cursor = params.get("cursor") ?? undefined;
    const page = await listDeletedAccounts(db, cursor);
    return NextResponse.json({ accounts: page.rows, nextCursor: page.nextCursor, now: new Date().toISOString() }, { headers: NO_STORE });
  }
  const email = lookupEmail(params.get("email"));
  if (!email) return fail(400, "Enter a valid email address.");
  const user = await findDeletionTarget(db, { email });
  if (!user) {
    await staffAudit(staff, "account_deletion_lookup", "not_found", "user.deletion_lookup_miss", {});
    return fail(404, "No customer account uses that email.");
  }
  await staffAudit(staff, "app_user", user.id, "user.deletion_lookup", {});
  return NextResponse.json({ user }, { headers: NO_STORE });
}

/**
 * Deletes an account. Body { userId, confirmEmail (the account's email, typed again), reason }. Closes the account, archives its
 * listings, cancels offers still in negotiation and emails the account holder and the other side of each cancelled offer.
 * The emails never block the deletion; how many went out is in the audit event.
 */
async function handlePost(req: Request) {
  const staff = await deletionGate(req);
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const userId = body["userId"];
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return fail(404, "Account not found.");
  const db = getDb();
  const target = await findDeletionTarget(db, { id: userId });
  if (!target) return fail(404, "Account not found.");
  const now = new Date().toISOString();
  const plan = planAccountDeletion(staff, target, { confirmEmail: body["confirmEmail"], reason: body["reason"] }, now);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  const done = await deleteAccountPg(db, staff, target.id, plan.reason, now, plan.windows);
  if (!done) return fail(409, "This account changed in the meantime. Reload and try again.");

  const brand = readBrand().name;
  const accountEmailSent = target.email ? await sendNotice(db, "account_deleted", target.email, accountDeletedEmail(brand, plan.windows.restoreUntil)) : false;
  let notified = 0;
  for (const o of done.cancelledOffers) {
    if (o.notify && await sendNotice(db, "offer_cancelled_account_closed", o.notify.email, offerCancelledEmail(brand, o.notify.role, o.listingTitle))) notified++;
  }
  await staffAudit(staff, "app_user", target.id, "user.deletion_notices", { accountEmailSent, counterpartiesNotified: notified, counterparties: done.cancelledOffers.length });
  return NextResponse.json({
    ok: true, restoreUntil: plan.windows.restoreUntil, retainUntil: plan.windows.retainUntil, listingsArchived: done.listings.length,
    offersCancelled: done.cancelledOffers.length, counterpartiesNotified: notified, liveOffersKept: done.liveOffers, accountEmailSent
  }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
