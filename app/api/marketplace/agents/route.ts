import { NextResponse } from "next/server";
import { parseBrowse } from "../../../../src/domain/agent-marketplace";
import { browseAgents, getMarketplaceDb } from "../../../../src/server/agent-marketplace-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Public: listed agents with filters q, area, specialty, language, mode, minRating, sort, page. No private data leaves here. */
async function handleGet(req: Request) {
  const q = parseBrowse(new URL(req.url).searchParams);
  return NextResponse.json(await browseAgents(getMarketplaceDb(), q), { headers: { "cache-control": "public, max-age=30" } });
}

export const GET = withApi(handleGet);
