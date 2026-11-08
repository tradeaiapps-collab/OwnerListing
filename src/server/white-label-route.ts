import { NextResponse } from "next/server";
import { csrfGuard } from "./csrf";
import { getActor, getDb } from "./context";
import { memberRole } from "./white-label-db";
import { UUID_RE, fail } from "./staff-route";

/**
 * Start of every agency white-label route: CSRF on state-changing methods, the signed-in agent, and an active manager role in the named team.
 * A non-member gets the same 404 as a team that does not exist, so team ids cannot be probed.
 */
export async function managerGate(req: Request, teamId: unknown): Promise<{ userId: string; teamId: string } | NextResponse> {
  if (req.method !== "GET") {
    const blocked = csrfGuard(req);
    if (blocked) return blocked;
  }
  const actor = await getActor(req);
  if (!actor) return fail(401, "Sign in required.");
  if (typeof teamId !== "string" || !UUID_RE.test(teamId)) return fail(400, "Send a valid teamId.");
  const role = await memberRole(getDb(), teamId, actor.userId);
  if (role === null) return fail(404, "Team not found.");
  if (role !== "manager") return fail(403, "Only a team manager can change the agency brand.");
  return { userId: actor.userId, teamId };
}
