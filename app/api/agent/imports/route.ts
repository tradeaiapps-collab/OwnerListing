import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { agentImports } from "../../../../src/server/property-feed-db";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's listings imported from their CRM feed. Agents only; each sees only their own connections. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "Only agents have CRM imports." }, { status: 403 });
  return NextResponse.json({ imports: await agentImports(getDb(), actor.userId) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
