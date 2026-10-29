import { NextResponse } from "next/server";
import { readBrand } from "../../../../../../src/config/brand";
import { accountRestoredEmail, planAccountRestore } from "../../../../../../src/domain/account-deletion";
import { findDeletionTarget, restoreAccountPg } from "../../../../../../src/server/account-deletion-db";
import { deletionGate } from "../../../../../../src/server/account-deletion-route";
import { getDb } from "../../../../../../src/server/context";
import { republishSuspended } from "../../../../../../src/server/listing-reinstate";
import { sendNotice } from "../../../../../../src/server/messaging";
import { fail, readJsonObject, staffAudit, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Restores a deleted account inside its recovery window. Body { reason }. The account returns to its previous status, its archived
 * listings come back (live ones only through today's publish gate; the rest stay suspended and are returned with the reasons), and
 * the account holder is emailed. Offers cancelled by the deletion stay cancelled.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await deletionGate(req);
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Account not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const target = await findDeletionTarget(db, { id });
  if (!target) return fail(404, "Account not found.");
  const now = new Date().toISOString();
  const plan = planAccountRestore(staff, target, { reason: body["reason"] }, now);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  const done = await restoreAccountPg(db, staff, id, plan.reason, now);
  if (!done) return fail(409, "This account can no longer be restored. Reload and check.");

  const live = done.listings.filter(l => l.wasPublished).map(l => l.id);
  const { restored, notRestored } = live.length > 0
    ? await republishSuspended(staff, live, { action: "restore_account", reason: plan.reason, restoredWithAccount: id })
    : { restored: 0, notRestored: [] };
  const emailSent = target.email
    ? await sendNotice(db, "account_restored", target.email, accountRestoredEmail(readBrand().name, (process.env["APP_URL"] ?? "").replace(/\/+$/, "")))
    : false;
  await staffAudit(staff, "app_user", id, "user.restore_notice", { emailSent });
  return NextResponse.json({
    ok: true, status: done.status, listingsBack: done.listings.length, listingsLive: restored, listingsNotRestored: notRestored, emailSent
  }, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
