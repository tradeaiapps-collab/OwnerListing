import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { readAuthEnv } from "../../../../../src/server/auth/config";
import { safeNextFromCookie } from "../../../../../src/server/auth/safe-next";
import { exchangeCode, readIdentity, vetGoogleName } from "../../../../../src/server/auth/google";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, readCookie, signSession } from "../../../../../src/server/auth/session";
import { STAFF_COOKIE, STAFF_TTL_SECONDS, signStaffSession } from "../../../../../src/server/auth/staff-session";
import { parseBootstrapEmails } from "../../../../../src/domain/staff-invite";
import { staffSignIn } from "../../../../../src/server/staff-auth";
import { guardContent } from "../../../../../src/server/content-guard";
import { createPgContentFlagStore } from "../../../../../src/server/content-flag-db";
import { upsertGoogleUser, vendorSignIn } from "../../../../../src/server/users";
import { withApi } from "../../../../../src/server/api/with-api";
import { afterSignIn, setUserSession } from "../../../../../src/server/auth/sign-in";

/** Finishes Google sign-in: checks state, exchanges the code, validates the ID token, then sets the session cookie. */
async function handleGet(req: Request) {
  const auth = readAuthEnv();
  if (!auth) return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  const failed = () => {
    const r = NextResponse.redirect(`${auth.appUrl}/?login=failed`);
    for (const c of ["ol_state", "ol_nonce", "ol_verifier", "ol_role", "ol_next"]) r.cookies.set(c, "", { path: "/api/auth/google", maxAge: 0 });
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
    if (readCookie(req, "ol_role") === "staff") {
      const staff = await staffSignIn(getDb(), who, parseBootstrapEmails(process.env["STAFF_BOOTSTRAP_ADMIN_EMAILS"]));
      if (!staff) return failed();
      const res = NextResponse.redirect(`${auth.appUrl}/`);
      res.cookies.set(STAFF_COOKIE, signStaffSession({ uid: staff.id, exp: now + STAFF_TTL_SECONDS }, auth.secret), {
        httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge: STAFF_TTL_SECONDS
      });
      for (const c of ["ol_state", "ol_nonce", "ol_verifier", "ol_role", "ol_next"]) res.cookies.set(c, "", { path: "/api/auth/google", maxAge: 0 });
      res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge: 0 });
      return res;
    }
    if (readCookie(req, "ol_role") === "vendor") {
      const vendor = await vendorSignIn(getDb(), who);
      if (!vendor) return failed();
      const res = NextResponse.redirect(`${auth.appUrl}${await afterSignIn(getDb(), vendor.id, "vendor", safeNextFromCookie(readCookie(req, "ol_next")) ?? "/")}`);
      res.cookies.set(SESSION_COOKIE, signSession({ uid: vendor.id, ut: "vendor", exp: now + SESSION_TTL_SECONDS }, auth.secret), {
        httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge: SESSION_TTL_SECONDS
      });
      for (const c of ["ol_state", "ol_nonce", "ol_verifier", "ol_role", "ol_next"]) res.cookies.set(c, "", { path: "/api/auth/google", maxAge: 0 });
      res.cookies.set(STAFF_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge: 0 });
      return res;
    }
    const role = readCookie(req, "ol_role");
    // The Google name is shown to others: abuse or contact details in it are replaced before the account is created.
    const vetted = vetGoogleName(who);
    const user = await upsertGoogleUser(getDb(), vetted.identity, role === "buyer" || role === "agent" ? role : "owner");
    if (!user) return failed();
    // Google only releases the identity when it vouches for the email (email_verified), so that counts as the email step of buyer verification.
    await getDb().query(
      `INSERT INTO buyer_verification (user_id, email_verified_at) VALUES ($1::uuid, now())
       ON CONFLICT (user_id) DO UPDATE SET email_verified_at = COALESCE(buyer_verification.email_verified_at, now())`,
      [user.id]
    );
    if (vetted.replaced && user.created) {
      await guardContent(createPgContentFlagStore(getDb()), { source: "profile", subjectType: "google_display_name", userId: user.id, fields: { display_name: who.name } });
    }

    // The session cookie is set now but counts as signed in only after the second step (see actorFromRequestChecked).
    const res = NextResponse.redirect(`${auth.appUrl}${await afterSignIn(getDb(), user.id, user.userType, safeNextFromCookie(readCookie(req, "ol_next")))}`);
    setUserSession(res, auth, user, now);
    for (const c of ["ol_state", "ol_nonce", "ol_verifier", "ol_role", "ol_next"]) res.cookies.set(c, "", { path: "/api/auth/google", maxAge: 0 });
    return res;
  } catch {
    return failed();
  }
}

export const GET = withApi(handleGet);
