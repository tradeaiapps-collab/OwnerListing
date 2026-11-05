import { NextResponse } from "next/server";
import { getMarketplaceDb, getSlots, marketplaceNow } from "../../../../../../src/server/agent-marketplace-db";
import { failure } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Public: free consultation slots for the next 14 days, in UTC, with the agent's timezone for display. */
async function handleGet(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  const r = await getSlots(getMarketplaceDb(), id, marketplaceNow());
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
