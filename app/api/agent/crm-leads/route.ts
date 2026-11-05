import { NextResponse } from "next/server";
import { isLeadStatus } from "../../../../src/domain/agent-leads";
import { listAgentLeads } from "../../../../src/server/agent-lead-db";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's buyer leads, most urgent first. Open leads by default; ?status= shows lost or converted ones; ?listing= narrows to one listing. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "Only agents have buyer leads." }, { status: 403 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status && !isLeadStatus(status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  const listing = url.searchParams.get("listing") ?? undefined;
  const leads = await listAgentLeads(getDb(), actor.userId, new Date().toISOString(), { ...(status && isLeadStatus(status) ? { status } : {}), ...(listing ? { listingId: listing } : {}) });
  return NextResponse.json({ leads }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
