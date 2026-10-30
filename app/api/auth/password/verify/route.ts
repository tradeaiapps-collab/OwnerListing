import { NextResponse } from "next/server";
import { readSessionEnv } from "../../../../../src/server/auth/config";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";
import { getEmailAuthDeps } from "../../../../../src/server/email-auth-context";
import { afterSignIn, setUserSession } from "../../../../../src/server/auth/sign-in";
import { safeNext } from "../../../../../src/server/auth/safe-next";
import { getDb } from "../../../../../src/server/context";
import { completeSignup } from "../../../../../src/server/email-auth";
import { emailAuthFailure, notConfigured } from "../../../../../src/server/email-auth-http";

/** Body: { token, next? }. Uses the sign-up link, creates the account and signs it in (owners and agents go on to set up the second step). */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const auth = readSessionEnv();
  if (!auth) return notConfigured();
  const body = (await req.json().catch(() => null)) as { token?: unknown; next?: unknown } | null;
  const r = await completeSignup(await getEmailAuthDeps(auth, "signup_verify"), body?.token);
  if (!r.ok) return emailAuthFailure(r);
  const redirect = await afterSignIn(getDb(), r.user.id, r.user.userType, safeNext(typeof body?.next === "string" ? body.next : undefined));
  return setUserSession(NextResponse.json({ redirect }), auth, r.user, Math.floor(Date.now() / 1000));
}

export const POST = withApi(handlePost);
