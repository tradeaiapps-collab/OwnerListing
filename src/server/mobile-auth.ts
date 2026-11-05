import { NextResponse } from "next/server";
import { mfaRequired } from "../domain/mfa";
import { readSessionEnv } from "./auth/config";
import { createMobileSession, refreshMobileSession, signOutMobileSession, type MobileTokens } from "./auth/mobile-session-db";
import { clientIp } from "./client-ip";
import { getDb } from "./context";
import { getEmailAuthDeps } from "./email-auth-context";
import { passwordSignIn } from "./email-auth";
import { emailAuthFailure, notConfigured } from "./email-auth-http";
import { getSessionState } from "./mfa-context";
import { mfaEnrolledPg } from "./mfa-db";
import { unauthenticated } from "./http";

/** Token replies must never be cached by a proxy or the phone's HTTP cache. */
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const tokenBody = (t: MobileTokens) => ({ accessToken: t.accessToken, refreshToken: t.refreshToken, tokenType: t.tokenType, expiresIn: t.expiresIn });

/**
 * Phone app sign-in. Body: { email, password, deviceLabel?, platform?: "android" | "ios" }. Same password check and rate limits as
 * the website. Answers the token pair plus where the account stands on the second step: when `mfa.required` and not yet passed, the
 * app asks for the code and sends it to /api/auth/mfa/verify with the access token; until then every other route answers 401.
 */
export async function mobileLogin(req: Request): Promise<NextResponse> {
  const auth = readSessionEnv();
  if (!auth) return notConfigured();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await passwordSignIn(await getEmailAuthDeps(auth, "signin"), body, clientIp(req));
  if (!r.ok) return emailAuthFailure(r);
  const db = getDb();
  const enrolled = await mfaEnrolledPg(db, r.user.id);
  const tokens = await createMobileSession(db, r.user, { label: body?.["deviceLabel"], platform: body?.["platform"] }, auth.secret, nowSeconds());
  return NextResponse.json(
    { ...tokenBody(tokens), user: { id: r.user.id, userType: r.user.userType }, mfa: { required: mfaRequired(r.user.userType, enrolled), enrolled } },
    { headers: NO_STORE }
  );
}

/** Body: { refreshToken }. Swaps it for a new pair; the old refresh token stops working. 401 means sign in again. */
export async function mobileRefresh(req: Request): Promise<NextResponse> {
  const auth = readSessionEnv();
  if (!auth) return notConfigured();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await refreshMobileSession(getDb(), body?.["refreshToken"], auth.secret, nowSeconds());
  if (!r.ok) return NextResponse.json({ error: "Sign in again.", code: "signed_out" }, { status: 401, headers: NO_STORE });
  return NextResponse.json(tokenBody(r.tokens), { headers: NO_STORE });
}

/** Ends this phone's session (bearer token required, works before the second step too). Unregister the push device first. */
export async function mobileLogout(req: Request): Promise<NextResponse> {
  const s = await getSessionState(req);
  if (!s || s.payload.sid === undefined) return unauthenticated();
  await signOutMobileSession(getDb(), s.payload.sid, s.actor.userId);
  return NextResponse.json({ ok: true });
}
