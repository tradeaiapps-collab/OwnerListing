import { NextResponse } from "next/server";
import { homeForRole, isUserRole, sessionTypeFor } from "../../../../../src/domain/roles";
import { withApi } from "../../../../../src/server/api/with-api";
import { SESSION_COOKIE } from "../../../../../src/server/auth/session";
import { signSession } from "../../../../../src/server/auth/session";
import { readSessionEnv } from "../../../../../src/server/auth/config";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getDb } from "../../../../../src/server/context";
import { getSessionState } from "../../../../../src/server/mfa-context";
import { readRoles, saveCurrentRole } from "../../../../../src/server/user-roles-db";

/**
 * Switches the view to a role the account already holds by re-issuing the session cookie with that permission class. Same expiry and
 * same second-step claim as before: switching never lengthens a session or skips a check. Owner and agent still need the second step,
 * so a session that has not passed it lands on /mfa after switching to one of them.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const auth = readSessionEnv();
  const s = await getSessionState(req);
  if (!auth || !s || s.staff || s.payload.ut === "vendor" || (s.mfa.required && !s.mfa.satisfied)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  // The phone app's token fixes its permission class; switching there would need a new token.
  if (s.payload.sid !== undefined) return NextResponse.json({ error: "Role switching is for the website." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { role?: unknown } | null;
  if (!isUserRole(body?.role)) return NextResponse.json({ error: "Choose buyer, owner, agent or investor." }, { status: 400 });
  const db = getDb();
  const st = await readRoles(db, s.payload.uid);
  if (!st || !st.roles.includes(body.role)) return NextResponse.json({ error: "Activate that role first." }, { status: 403 });
  const ut = sessionTypeFor(body.role);
  const res = NextResponse.json({ currentRole: body.role, next: homeForRole(body.role) });
  res.cookies.set(SESSION_COOKIE, signSession({ uid: s.payload.uid, ut, exp: s.payload.exp, ...(s.payload.mfa !== undefined ? { mfa: s.payload.mfa } : {}), ...(body.role === "investor" ? { cr: "investor" as const } : {}) }, auth.secret), {
    httpOnly: true, sameSite: "lax", secure: auth.secureCookies, path: "/", maxAge: Math.max(0, s.payload.exp - Math.floor(Date.now() / 1000))
  });
  await saveCurrentRole(db, s.payload.uid, body.role);
  return res;
}

export const POST = withApi(handlePost);
