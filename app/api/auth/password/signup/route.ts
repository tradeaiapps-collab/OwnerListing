import { NextResponse } from "next/server";
import { readSessionEnv } from "../../../../../src/server/auth/config";
import { clientIp } from "../../../../../src/server/client-ip";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";
import { getEmailAuthDeps } from "../../../../../src/server/email-auth-context";
import { startSignup } from "../../../../../src/server/email-auth";
import { emailAuthFailure, notConfigured } from "../../../../../src/server/email-auth-http";

/** Body: { name, email, password, userType: "buyer" | "owner" | "agent" }. Always answers the same for a new or a known address. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const auth = readSessionEnv();
  if (!auth) return notConfigured();
  const r = await startSignup(await getEmailAuthDeps(auth, "signup_verify"), await req.json().catch(() => null), clientIp(req));
  return r.ok ? NextResponse.json({ sent: true }, { status: 202 }) : emailAuthFailure(r);
}

export const POST = withApi(handlePost);
