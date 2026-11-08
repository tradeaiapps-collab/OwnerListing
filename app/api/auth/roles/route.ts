import { NextResponse } from "next/server";
import { activeRole, isUserRole } from "../../../../src/domain/roles";
import { withApi } from "../../../../src/server/api/with-api";
import { csrfGuard } from "../../../../src/server/csrf";
import { getDb } from "../../../../src/server/context";
import { getSessionState } from "../../../../src/server/mfa-context";
import { activateRole, readRoles } from "../../../../src/server/user-roles-db";

const OK_SESSION = (s: Awaited<ReturnType<typeof getSessionState>>) => (s && !s.staff && (!s.mfa.required || s.mfa.satisfied) ? s : null);

/** The roles on the signed-in account and the one being viewed now. */
async function handleGet(req: Request) {
  const s = OK_SESSION(await getSessionState(req));
  if (!s) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const st = await readRoles(getDb(), s.payload.uid);
  if (!st) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const ut = s.payload.ut;
  if (ut === "vendor") return NextResponse.json({ roles: [], currentRole: null });
  return NextResponse.json({ roles: st.roles, currentRole: activeRole(ut, s.payload.cr, st.roles), primary: st.primary });
}

/** Activates another role on the account. It does not switch to it; the person does that with /switch. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = OK_SESSION(await getSessionState(req));
  if (!s || s.payload.sid !== undefined) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { role?: unknown } | null;
  if (!isUserRole(body?.role)) return NextResponse.json({ error: "Choose buyer, owner, agent or investor." }, { status: 400 });
  const roles = await activateRole(getDb(), s.payload.uid, body.role);
  if (!roles) return NextResponse.json({ error: "This account cannot add roles." }, { status: 403 });
  return NextResponse.json({ roles });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
