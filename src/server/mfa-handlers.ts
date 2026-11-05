/** Handlers of the MFA routes. They serve users (/api/auth/mfa) and staff (/api/staff/mfa, the only path the admin site allows) alike: getMfaSessionState picks the session. */
import { readBrand } from "../config/brand";
import { clientIp } from "./client-ip";
import { csrfGuard } from "./csrf";
import { failure, unauthenticated } from "./http";
import { confirmFactor, mfaStatus, regenerateRecoveryCodes, removeFactor, sendSignInSms, startSms, startTotp, verifySecondFactor } from "./mfa";
import { getMfaDeps, getMfaSessionState, markMfaPassed, mfaRequiredResponse, requireRecentMfa } from "./mfa-context";
import { NextResponse } from "next/server";

/** What the MFA page shows: whether a check is required and passed, which methods are set up and which can be offered. */
export async function mfaStatusGet(req: Request) {
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  return NextResponse.json(await mfaStatus(await getMfaDeps(), s, readBrand().name), { headers: { "cache-control": "private, no-store" } });
}

/** Body: { method: "totp" | "sms" | "recovery", code }. Marks this session as having passed MFA. */
export async function mfaVerifyPost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  const r = await verifySecondFactor(await getMfaDeps(), s.actor.userId, clientIp(req), await req.json().catch(() => null));
  return r.ok ? markMfaPassed(NextResponse.json({ verified: true, ...r.value }), s) : failure(r);
}

/** Starts authenticator set-up. Returns the secret and otpauth address once; the secret is stored sealed and never shown again. */
export async function mfaTotpSetupPost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await startTotp(await getMfaDeps(), s.actor.userId);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Body: { code }. Finishes setting up the authenticator app. The first method also returns 10 recovery codes, shown once. */
export async function mfaTotpConfirmPost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  // A second method can only be added by a session that has already passed MFA.
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await confirmFactor(await getMfaDeps(), s.actor.userId, clientIp(req), "totp", await req.json().catch(() => null));
  return r.ok ? markMfaPassed(NextResponse.json({ enrolled: true, ...r.value }, { headers: { "cache-control": "no-store" } }), s) : failure(r);
}

/** Body: { phone, consent: true }. Starts text-message set-up and texts a 6-digit code to the number. */
export async function mfaSmsSetupPost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await startSms(await getMfaDeps(), s.actor.userId, clientIp(req), await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Body: { code }. Finishes setting up text message codes. The first method also returns 10 recovery codes, shown once. */
export async function mfaSmsConfirmPost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  // A second method can only be added by a session that has already passed MFA.
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await confirmFactor(await getMfaDeps(), s.actor.userId, clientIp(req), "sms", await req.json().catch(() => null));
  return r.ok ? markMfaPassed(NextResponse.json({ enrolled: true, ...r.value }, { headers: { "cache-control": "no-store" } }), s) : failure(r);
}

/** Texts a sign-in code to the account's confirmed mobile number. */
export async function mfaSmsSendPost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  const r = await sendSignInSms(await getMfaDeps(), s.actor.userId, clientIp(req));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Issues a fresh set of 10 recovery codes (shown once); the old set stops working. Needs a check in the last 15 minutes. */
export async function mfaRecoveryCodesPost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  const stale = await requireRecentMfa(req);
  if (stale) return stale;
  const r = await regenerateRecoveryCodes(await getMfaDeps(), s.actor.userId);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Removes a sign-in method. Needs a check in the last 15 minutes. Other sessions that passed MFA before now are signed out of MFA. */
export async function mfaMethodsDelete(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getMfaSessionState(req);
  if (!s) return unauthenticated();
  const stale = await requireRecentMfa(req);
  if (stale) return stale;
  const r = await removeFactor(await getMfaDeps(), s, (await params).id);
  return r.ok ? markMfaPassed(NextResponse.json(r.value), s) : failure(r);
}
