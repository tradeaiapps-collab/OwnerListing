import { NextResponse } from "next/server";
import { readSessionEnv } from "../../../../../src/server/auth/config";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";
import { getEmailAuthDeps } from "../../../../../src/server/email-auth-context";
import { completePasswordReset } from "../../../../../src/server/email-auth";
import { emailAuthFailure, notConfigured } from "../../../../../src/server/email-auth-http";

/** Body: { token, password }. Sets the new password and ends every existing session; the person then signs in again. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const auth = readSessionEnv();
  if (!auth) return notConfigured();
  const r = await completePasswordReset(await getEmailAuthDeps(auth, "password_reset"), await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ reset: true }) : emailAuthFailure(r);
}

export const POST = withApi(handlePost);
