import { NextResponse } from "next/server";
import { readAppMode } from "../../../../src/config/app-mode";
import { DEV_EMAIL_DOMAIN, devLoginAllowed, devLoginSurface } from "../../../../src/server/dev-login";
import { csrfGuard } from "../../../../src/server/csrf";
import { getDb } from "../../../../src/server/context";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../../../../src/server/auth/session";
import { STAFF_COOKIE, STAFF_TTL_SECONDS, signStaffSession } from "../../../../src/server/auth/staff-session";
import { isRoleKey } from "../../../../src/domain/staff-roles";
import { withApi } from "../../../../src/server/api/with-api";

const notFound = () => new NextResponse("Not found", { status: 404 });

/** DEV-ONLY. Mints the normal session cookie for a seeded demo account. 404 unless devLoginAllowed(); see src/server/dev-login.ts. */
async function handlePost(req: Request) {
  if (!devLoginAllowed(req)) return notFound();
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "SESSION_SECRET is not set." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return NextResponse.json({ error: "Unknown account." }, { status: 400 });

  const surface = devLoginSurface(readAppMode());
  // Only seeded demo accounts (reserved .invalid addresses) can ever be signed in this way.
  const row = (await getDb().query(
    `SELECT u.id, u.user_type, i.role FROM app_user u
       LEFT JOIN staff_invite i ON i.email = lower(u.email::text) AND i.revoked_at IS NULL AND i.accepted_at IS NOT NULL
      WHERE u.id = $1 AND u.status = 'active' AND u.email LIKE $2`,
    [userId, `%${DEV_EMAIL_DOMAIN}`]
  )).rows[0];
  if (!row) return NextResponse.json({ error: "Unknown account." }, { status: 400 });

  const now = Math.floor(Date.now() / 1000);
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: false, path: "/" };
  if (row["user_type"] === "admin") {
    if (!surface.staff || !isRoleKey(row["role"])) return NextResponse.json({ error: "Staff accounts sign in on the admin site." }, { status: 400 });
    const res = NextResponse.json({ ok: true, redirect: "/staff" });
    res.cookies.set(STAFF_COOKIE, signStaffSession({ uid: userId, exp: now + STAFF_TTL_SECONDS, mfa: now }, secret), { ...opts, maxAge: STAFF_TTL_SECONDS });
    res.cookies.set(SESSION_COOKIE, "", { ...opts, maxAge: 0 });
    return res;
  }
  const ut = row["user_type"];
  if (!surface.users || (ut !== "owner" && ut !== "agent" && ut !== "buyer" && ut !== "vendor")) {
    return NextResponse.json({ error: "User accounts sign in on the public site." }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, redirect: ut === "buyer" ? "/buyer/saved-searches" : "/dashboard" });
  // Seeded demo accounts have no second factor; this local-only sign-in stands in for it (never reachable off localhost, see devLoginAllowed).
  res.cookies.set(SESSION_COOKIE, signSession({ uid: userId, ut, exp: now + SESSION_TTL_SECONDS, mfa: now }, secret), { ...opts, maxAge: SESSION_TTL_SECONDS });
  res.cookies.set(STAFF_COOKIE, "", { ...opts, maxAge: 0 });
  return res;
}

export const POST = withApi(handlePost);
