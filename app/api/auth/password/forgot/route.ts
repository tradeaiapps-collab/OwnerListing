import { NextResponse } from "next/server";
import { readSessionEnv } from "../../../../../src/server/auth/config";
import { clientIp } from "../../../../../src/server/client-ip";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";
import { getEmailAuthDeps } from "../../../../../src/server/email-auth-context";
import { requestPasswordReset } from "../../../../../src/server/email-auth";
import { emailAuthFailure, notConfigured } from "../../../../../src/server/email-auth-http";

/** Body: { email }. Always answers the same, whether or not the address has an account. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const auth = readSessionEnv();
  if (!auth) return notConfigured();
  const r = await requestPasswordReset(await getEmailAuthDeps(auth, "password_reset"), await req.json().catch(() => null), clientIp(req));
  return r.ok ? NextResponse.json({ sent: true }, { status: 202 }) : emailAuthFailure(r);
}

export const POST = withApi(handlePost);
