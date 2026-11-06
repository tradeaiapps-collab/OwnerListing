import { NextResponse } from "next/server";
import { withApi } from "../../../../src/server/api/with-api";
import { getSessionState } from "../../../../src/server/mfa-context";

/** The signed-in user, or null. A session still waiting on its second sign-in step answers user: null with mfaPending, so pages can send it to /mfa. */
async function handleGet(req: Request) {
  const s = await getSessionState(req);
  if (s && s.mfa.required && !s.mfa.satisfied) return NextResponse.json({ user: null, mfaPending: { enrolled: s.mfa.enrolled } });
  return NextResponse.json({ user: s ? { id: s.actor.userId, userType: s.actor.userType, ...(s.payload.cr ? { currentRole: s.payload.cr } : {}) } : null });
}

export const GET = withApi(handleGet);
