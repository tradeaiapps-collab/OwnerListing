import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { readAuthEnv } from "../../../../../src/server/auth/config";
import { exchangeCode, readIdentity } from "../../../../../src/server/auth/google";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, readCookie, signSession } from "../../../../../src/server/auth/session";
import { upsertGoogleUser } from "../../../../../src/server/users";

/** Finishes Google sign-in: checks state, exchanges the code, validates the ID token, then sets the session cookie. */
export async function GET(req: Request) {
  const auth = readAuthEnv();
  if (!auth) return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  const failed = () => {
    const r = NextResponse.redirect(`${auth.appUrl}/?login=failed`);
    for (const c of ["ol_state", "ol_nonce", "ol_verifier", "ol_role"]) r.cookies.set(c, "", { path: "/api/auth/google", maxAge: 0 });
    return r;
  };

  const q = new URL(req.url).searchParams;
  const code = q.get("code");
  const state = readCookie(req, "ol_state");
  const nonce = readCookie(req, "ol_nonce");
  const verifier = readCookie(req, "ol_verifier");
  if (!code || !state || !nonce || !verifier || q.get("state") !== state) return failed();

  try {
    const claims = await exchangeCode(auth.google, code, verifier);
    const now = Math.floor(Date.now() / 1000);
    const who = claims && readIdentity(claims, { clientId: auth.google.clientId, nonce, nowSeconds: now });
    if (!who) return failed();
    const user = await upsertGoogleUser(getDb(), who, readCookie(req, "ol_role") === "buyer" ? "buyer" : "owner");
    if (!user) return failed();

    const res = NextResponse.redirect(`${auth.appUrl}${user.userType === "buyer" ? "/buyer/saved-searches" : "/listings/new"}`);
    res.cookies.set(SESSION_COOKIE, signSession({ uid: user.id, ut: user.userType, exp: now + SESSION_TTL_SECONDS }, auth.secret), {
      httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge: SESSION_TTL_SECONDS
    });
    for (const c of ["ol_state", "ol_nonce", "ol_verifier", "ol_role"]) res.cookies.set(c, "", { path: "/api/auth/google", maxAge: 0 });
    return res;
  } catch {
    return failed();
  }
}
