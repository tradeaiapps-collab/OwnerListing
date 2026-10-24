import { NextResponse } from "next/server";
import { STAFF_COOKIE } from "../../../../src/server/auth/staff-session";
import { SESSION_COOKIE } from "../../../../src/server/auth/session";
import { csrfGuard } from "../../../../src/server/csrf";

export async function POST(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  res.cookies.set(STAFF_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
