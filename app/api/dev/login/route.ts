import { NextResponse } from "next/server";
import { readAppMode } from "../../../../src/config/app-mode";
import { DEV_EMAIL_DOMAIN, devLoginAllowed, devLoginSurface } from "../../../../src/server/dev-login";
import { csrfGuard } from "../../../../src/server/csrf";
import { getDb } from "../../../../src/server/context";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../../../../src/server/auth/session";
import { STAFF_COOKIE, STAFF_TTL_SECONDS, signStaffSession } from "../../../../src/server/auth/staff-session";
import { AU_JURISDICTIONS } from "../../../../src/domain/jurisdiction";
import { isRoleKey } from "../../../../src/domain/staff-roles";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * DEV-ONLY. A dev sign-in account may use every gated feature, so testing is never blocked by a missing verification. Runs only after
 * devLoginAllowed() and only for the reserved @demo.invalid accounts: agents get a verified licence in every state, buyers get email, phone and ID
 * verified. Existing records are upgraded in place. Real accounts never go through this route, so production behaviour is unchanged.
 */
async function grantDevAccess(userId: string, userType: string) {
  const db = getDb();
  if (userType === "agent") {
    for (const j of AU_JURISDICTIONS) {
      await db.query(
        `INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at, expires_at)
         VALUES ($1, $2, $3, 'verified', $1, now(), (now() + interval '1 year')::date)
         ON CONFLICT (user_id, jurisdiction) DO UPDATE SET status = 'verified', verified_by = $1, verified_at = now(), expires_at = (now() + interval '1 year')::date`,
        [userId, j, `DEV-${j}-1`]
      );
    }
  } else if (userType === "buyer") {
    await db.query(
      `INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, phone_e164, id_verified_at, id_method)
       VALUES ($1, now(), now(), '+61400000000', now(), 'manual_review')
       ON CONFLICT (user_id) DO UPDATE SET email_verified_at = COALESCE(buyer_verification.email_verified_at, now()),
         phone_verified_at = COALESCE(buyer_verification.phone_verified_at, now()),
         phone_e164 = COALESCE(buyer_verification.phone_e164, '+61400000000'),
         id_verified_at = COALESCE(buyer_verification.id_verified_at, now()),
         id_method = COALESCE(buyer_verification.id_method, 'manual_review')`,
      [userId]
    );
  }
}

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
    `SELECT u.id, u.user_type, u.roles, u.active_role, i.role FROM app_user u
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
  await grantDevAccess(userId, ut as string);
  // A buyer account that holds the investor role and last viewed as one signs in as that investor.
  const asInvestor = ut === "buyer" && row["active_role"] === "investor" && Array.isArray(row["roles"]) && row["roles"].includes("investor");
  const res = NextResponse.json({ ok: true, redirect: ut === "buyer" && !asInvestor ? "/buyer/saved-searches" : ut === "vendor" ? "/contractor/profile" : "/dashboard" });
  // Seeded demo accounts have no second factor; this local-only sign-in stands in for it (never reachable off localhost, see devLoginAllowed).
  res.cookies.set(SESSION_COOKIE, signSession({ uid: userId, ut, ...(asInvestor ? { cr: "investor" as const } : {}), exp: now + SESSION_TTL_SECONDS, mfa: now }, secret), { ...opts, maxAge: SESSION_TTL_SECONDS });
  res.cookies.set(STAFF_COOKIE, "", { ...opts, maxAge: 0 });
  return res;
}

export const POST = withApi(handlePost);
