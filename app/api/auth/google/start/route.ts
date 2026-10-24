import { NextResponse } from "next/server";
import { readAuthEnv } from "../../../../../src/server/auth/config";
import { buildAuthUrl } from "../../../../../src/server/auth/google";
import { randomToken } from "../../../../../src/server/auth/session";

/** Starts Google sign-in with state, nonce and PKCE. The secrets and the owner-or-buyer choice live in short-lived HttpOnly cookies. */
export async function GET(req: Request) {
  const auth = readAuthEnv();
  if (!auth) return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  const s = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
  const res = NextResponse.redirect(buildAuthUrl(auth.google, s));
  const opts = { httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/api/auth/google", maxAge: 600 } as const;
  res.cookies.set("ol_state", s.state, opts);
  res.cookies.set("ol_nonce", s.nonce, opts);
  res.cookies.set("ol_verifier", s.verifier, opts);
  // Only "buyer" and "staff" are honoured; anything else (including "agent" or "admin") means the default, owner.
  // "staff" grants nothing by itself: the callback still requires a pre-provisioned staff account.
  const as = new URL(req.url).searchParams.get("as");
  res.cookies.set("ol_role", as === "buyer" || as === "staff" ? as : "owner", opts);
  return res;
}
