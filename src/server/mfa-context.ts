import { NextResponse } from "next/server";
import { readBrand } from "../config/brand";
import { stepUpSatisfied } from "../domain/mfa";
import { sessionFromRequestChecked, type SessionState } from "./auth/actor";
import { readAuthEnv } from "./auth/config";
import { SESSION_COOKIE, signSession } from "./auth/session";
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
  const auth = readAuthEnv();
  return auth ? sessionFromRequestChecked(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}

/** Re-issues the session cookie marked as having passed MFA now. Same expiry as before: passing MFA never lengthens a session. */
export function markMfaPassed(res: NextResponse, s: SessionState, nowSeconds = Math.ceil(Date.now() / 1000)): NextResponse {
  const auth = readAuthEnv();
  if (!auth) return res;
  const maxAge = Math.max(0, s.payload.exp - Math.floor(Date.now() / 1000));
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
  const s = await getSessionState(req);
  return s && s.mfa.satisfied && stepUpSatisfied(s.payload.mfa, Math.floor(Date.now() / 1000)) ? null : mfaRequiredResponse();
}
