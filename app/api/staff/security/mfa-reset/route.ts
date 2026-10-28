import { NextResponse } from "next/server";
import { readBrand } from "../../../../../src/config/brand";
import { canResetMfa, lookupEmail, mfaResetEmail, planMfaReset } from "../../../../../src/domain/mfa-reset";
import { getDb } from "../../../../../src/server/context";
import { getEmailPort } from "../../../../../src/server/messaging";
import { findMfaResetTarget, resetUserMfa } from "../../../../../src/server/mfa-reset-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" };

/** Super admin only: the sensitive permission and the super_admin role itself (a custom role holding the permission is refused). */
async function gate(req: Request) {
  const staff = await staffGate(req, "user.mfa_reset");
  if (staff instanceof NextResponse) return staff;
  return canResetMfa(staff) ? staff : fail(403, "Not allowed.");
}

/** Looks up an account by email: ?email=. Shows its sign-in methods (phone as the last 3 digits only) and past resets. Every lookup is audited. */
async function handleGet(req: Request) {
  const staff = await gate(req);
  if (staff instanceof NextResponse) return staff;
  const email = lookupEmail(new URL(req.url).searchParams.get("email"));
  if (!email) return fail(400, "Enter a valid email address.");
  const user = await findMfaResetTarget(getDb(), { email });
  if (!user) return fail(404, "No account uses that email.");
  await staffAudit(staff, "app_user", user.id, "mfa.reset_lookup", {});
  return NextResponse.json({ user }, { headers: NO_STORE });
}

/**
 * Resets the account's two-step sign-in. Body { userId, confirmEmail (the account's email, typed again), reason }. Revokes every method,
 * retires recovery codes, ends every session that passed MFA, logs the reset and emails the user. The email never blocks the reset.
 */
async function handlePost(req: Request) {
  const staff = await gate(req);
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const userId = body["userId"];
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return fail(404, "Account not found.");
  const db = getDb();
  const target = await findMfaResetTarget(db, { id: userId });
  if (!target) return fail(404, "Account not found.");
  const plan = planMfaReset(staff, target, { confirmEmail: body["confirmEmail"], reason: body["reason"] });
  if (plan.action === "deny") return fail(plan.status, plan.error);
  const done = await resetUserMfa(db, staff.id, target.id, plan.reason);
  if (!done) return fail(409, "This account has no two-step sign-in method to reset. Reload and check.");

  let emailSent = false;
  try {
    const port = await getEmailPort(db, process.env, "mfa_reset");
    if (port.configured) {
      const msg = mfaResetEmail(readBrand().name, (process.env["APP_URL"] ?? "").replace(/\/+$/, ""));
      emailSent = (await port.send({ to: target.email, ...msg })).status === "sent";
    }
  } catch { /* the notice never blocks the reset; the outbox records the attempt */ }

  await staffAudit(staff, "app_user", target.id, "mfa.reset_by_staff", { reason: plan.reason, methodsRevoked: done.methodsRevoked, emailSent });
  return NextResponse.json({ ok: true, methodsRevoked: done.methodsRevoked, resetAt: done.resetAt, emailSent }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
