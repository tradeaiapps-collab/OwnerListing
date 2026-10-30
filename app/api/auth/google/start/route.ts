import { NextResponse } from "next/server";
import { readAuthEnv } from "../../../../../src/server/auth/config";
import { buildAuthUrl } from "../../../../../src/server/auth/google";
import { safeNext } from "../../../../../src/server/auth/safe-next";
import { randomToken } from "../../../../../src/server/auth/session";
import { withApi } from "../../../../../src/server/api/with-api";

/** Starts Google sign-in with state, nonce and PKCE. The secrets and the account-type choice live in short-lived HttpOnly cookies. */
async function handleGet(req: Request) {
  const auth = readAuthEnv();
  if (!auth) return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  const s = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
  const res = NextResponse.redirect(buildAuthUrl(auth.google, s));
  const opts = { httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/api/auth/google", maxAge: 600 } as const;
  res.cookies.set("ol_state", s.state, opts);
  res.cookies.set("ol_nonce", s.nonce, opts);
  res.cookies.set("ol_verifier", s.verifier, opts);
  // Only "buyer", "agent", "staff" and "vendor" are honoured; anything else (including "admin") means the default, owner.
  // "buyer" and "agent" apply only when a new account is created. "staff" and "vendor" grant nothing by themselves: the callback
  // still requires a pre-provisioned account of that type.
  const as = new URL(req.url).searchParams.get("as");
  res.cookies.set("ol_role", as === "buyer" || as === "agent" || as === "staff" || as === "vendor" ? as : "owner", opts);
  // Optional return path; anything that is not a same-site relative path is dropped.
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (next) res.cookies.set("ol_next", next, opts);
  return res;
}

export const GET = withApi(handleGet);
