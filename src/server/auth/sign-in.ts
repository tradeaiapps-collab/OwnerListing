import type { NextResponse } from "next/server";
import { homeFor } from "../../domain/email-auth";
import { mfaRequired } from "../../domain/mfa";
import type { Queryable } from "../db";
import { mfaEnrolledPg } from "../mfa-db";
import type { SessionEnv } from "./config";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, type SessionPayload } from "./session";
import { STAFF_COOKIE } from "./staff-session";

type UserType = SessionPayload["ut"];

/** Where to go after the first sign-in step: straight to `dest` (or the account's home), or first to /mfa when this account needs it. */
export async function afterSignIn(db: Queryable, userId: string, userType: UserType, dest: string | undefined): Promise<string> {
  const to = dest ?? homeFor(userType);
  const needs = mfaRequired(userType, userType === "owner" || userType === "agent" ? true : await mfaEnrolledPg(db, userId));
  return needs ? `/mfa?next=${encodeURIComponent(to)}` : to;
}

/**
 * Sets the user session cookie and clears any staff session. The cookie counts as signed in only after the second step where one is
 * needed (see actorFromRequestChecked).
 */
export function setUserSession<T extends NextResponse>(res: T, env: SessionEnv, user: { id: string; userType: UserType }, nowSeconds: number): T {
  const opts = { httpOnly: true, sameSite: "lax", secure: env.secureCookies, path: "/" } as const;
  res.cookies.set(SESSION_COOKIE, signSession({ uid: user.id, ut: user.userType, exp: nowSeconds + SESSION_TTL_SECONDS }, env.secret), { ...opts, maxAge: SESSION_TTL_SECONDS });
  res.cookies.set(STAFF_COOKIE, "", { ...opts, maxAge: 0 });
  return res;
}
