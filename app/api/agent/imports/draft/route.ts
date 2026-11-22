import { NextResponse } from "next/server";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../src/server/http";
import { startDraftFromImport } from "../../../../../src/server/property-feed-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Starts (or reopens) a draft listing from one imported CRM listing: body {connectionId, externalId}. Nothing publishes. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => ({}))) as { connectionId?: unknown; externalId?: unknown };
  const r = await startDraftFromImport(getDb(), getDeps(), actor, String(body.connectionId ?? ""), String(body.externalId ?? ""));
  return r.ok ? NextResponse.json({ listingId: r.listingId, created: r.created }, { status: r.created ? 201 : 200 }) : NextResponse.json({ error: r.error }, { status: r.status });
}

export const POST = withApi(handlePost);
