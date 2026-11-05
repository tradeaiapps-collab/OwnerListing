import { NextResponse } from "next/server";
import { readBrand } from "../config/brand";
import { stepUpSatisfied } from "../domain/mfa";
import { sessionFromRequestChecked, type SessionState } from "./auth/actor";
import { readSessionEnv } from "./auth/config";
import { markMobileMfaPassed } from "./auth/mobile-session-db";
import { SESSION_COOKIE, signSession } from "./auth/session";
import { STAFF_COOKIE, signStaffSession } from "./auth/staff-session";
import { staffSessionFromRequest } from "./staff-auth";
import { getDb } from "./context";
import type { MfaDeps } from "./mfa";
import { createPgMfaStore } from "./mfa-db";
import { getSmsPort } from "./messaging";

/** MFA flows fail closed: MFA_SECRET_KEY unset or malformed = set-up and sign-in checks answer "unavailable". */
export async function getMfaDeps(): Promise<MfaDeps> {
  return { store: createPgMfaStore(getDb()), sms: await getSmsPort(getDb(), process.env, "mfa_code"), key: process.env["MFA_SECRET_KEY"], issuer: readBrand().name };
}

/** The signed-in session whether or not it has passed MFA yet (only the MFA routes and /api/auth/me use this). */
export async function getSessionState(req: Request): Promise<SessionState | null> {
  const auth = readSessionEnv();
  return auth ? sessionFromRequestChecked(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}

/**
 * Session state for the MFA routes (/api/auth/mfa/*), which serve users and staff alike: the user session if there is one, otherwise
 * the staff session. A staff member's second step is optional (required only once a method is enrolled).
 */
export async function getMfaSessionState(req: Request): Promise<SessionState | null> {
  const user = await getSessionState(req);
  if (user) return user;
  const auth = readSessionEnv();
  const s = auth ? await staffSessionFromRequest(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
  if (!s) return null;
  return {
    actor: { userId: s.staff.id, userType: "buyer" }, staff: true,
    payload: { uid: s.staff.id, ut: "buyer", exp: s.payload.exp, ...(s.payload.mfa !== undefined ? { mfa: s.payload.mfa } : {}) },
    mfa: { required: s.mfa.enrolled, enrolled: s.mfa.enrolled, satisfied: s.mfa.satisfied }
  };
}

/**
 * Re-issues the session cookie marked as having passed MFA now. Same expiry as before: passing MFA never lengthens a session.
 * A phone app session (bearer token) gets no cookie: its own session row records the check instead.
 */
export async function markMfaPassed(res: NextResponse, s: SessionState, nowSeconds = Math.ceil(Date.now() / 1000)): Promise<NextResponse> {
  if (s.payload.sid !== undefined) {
    await markMobileMfaPassed(getDb(), s.payload.sid, s.payload.uid);
    return res;
  }
  const auth = readSessionEnv();
  if (!auth) return res;
  const maxAge = Math.max(0, s.payload.exp - Math.floor(Date.now() / 1000));
  if (s.staff) {
    res.cookies.set(STAFF_COOKIE, signStaffSession({ uid: s.payload.uid, exp: s.payload.exp, mfa: nowSeconds }, auth.secret), {
      httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge
    });
    return res;
  }
  res.cookies.set(SESSION_COOKIE, signSession({ uid: s.payload.uid, ut: s.payload.ut, exp: s.payload.exp, mfa: nowSeconds }, auth.secret), {
    httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge
  });
  return res;
}

/** 403 with code mfa_required: the caller's page sends the user to /mfa and retries after the check. */
export const mfaRequiredResponse = () =>
  NextResponse.json({ error: "Confirm it's you with your second sign-in step, then try again.", code: "mfa_required", nextStep: "verify_mfa" }, { status: 403 });

/**
 * Step-up for sensitive actions (publish, accept an offer): the session must have passed MFA in the last 15 minutes.
 * Returns the 403 to send, or null to proceed. Call after the route's own sign-in check.
 */
export async function requireRecentMfa(req: Request): Promise<NextResponse | null> {
  return (await recentMfaAt(req)) === undefined ? mfaRequiredResponse() : null;
}

/**
 * Step-up for staff money actions (approving a payout, resolving or paying out a sale-fell-through case): the staff session must have
 * passed MFA in the last 15 minutes. Staff who have not set up two-step sign-in are refused too (nextStep enroll_mfa): these actions
 * need a second factor. Re-checking only needs the code, never a new Google sign-in. Call after staffGate. Returns the 403 to send, or null.
 */
export async function requireRecentStaffMfa(req: Request): Promise<NextResponse | null> {
  const auth = readSessionEnv();
  const s = auth ? await staffSessionFromRequest(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
  if (s && s.mfa.satisfied && stepUpSatisfied(s.payload.mfa, Math.floor(Date.now() / 1000))) return null;
  return NextResponse.json(
    { error: s?.mfa.enrolled === false ? "Set up two-step sign-in, then try again. This action needs it." : "Confirm it's you with your second sign-in step, then try again.",
      code: "mfa_required", nextStep: s?.mfa.enrolled === false ? "enroll_mfa" : "verify_mfa" },
    { status: 403 }
  );
}

/** When this session last passed MFA (epoch seconds) if that is within the step-up window and still valid, else undefined. */
export async function recentMfaAt(req: Request): Promise<number | undefined> {
  const s = await getMfaSessionState(req);
  return s && s.mfa.satisfied && stepUpSatisfied(s.payload.mfa, Math.floor(Date.now() / 1000)) ? s.payload.mfa : undefined;
}
