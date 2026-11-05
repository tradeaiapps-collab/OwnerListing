import { NextResponse } from "next/server";
import { isLeadStatus } from "../../../../src/domain/ad-leads";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { listLeads } from "../../../../src/server/ad-lead-db";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's own leads (never test leads, never anyone else's). Agents only. ?status= filters; ?offset= pages. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "Only agents have ad leads." }, { status: 403 });
  const url = new URL(req.url);
  const raw = url.searchParams.get("status");
  if (raw && !isLeadStatus(raw)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const r = await listLeads(getDb(), { agentId: actor.userId, ...(raw && isLeadStatus(raw) ? { status: raw } : {}), excludeTests: true, limit: 50, offset: Number.isFinite(offset) ? offset : 0 });
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
