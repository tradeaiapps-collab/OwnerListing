import { NextResponse } from "next/server";
import { readAuthEnv } from "../../../../../src/server/auth/config";
import { buildAuthUrl } from "../../../../../src/server/auth/google";
import { randomToken } from "../../../../../src/server/auth/session";

/** Starts Google sign-in with state, nonce and PKCE. The three secrets live in short-lived HttpOnly cookies. */
export async function GET() {
  const auth = readAuthEnv();
  if (!auth) return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  const s = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
  const res = NextResponse.redirect(buildAuthUrl(auth.google, s));
  const opts = { httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/api/auth/google", maxAge: 600 } as const;
  res.cookies.set("ol_state", s.state, opts);
  res.cookies.set("ol_nonce", s.nonce, opts);
  res.cookies.set("ol_verifier", s.verifier, opts);
  return res;
}
