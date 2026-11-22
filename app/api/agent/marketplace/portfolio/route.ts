import { NextResponse } from "next/server";
import { addPortfolioItem, getMarketplaceDb, marketplaceNow } from "../../../../../src/server/agent-marketplace-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { createPgContentFlagStore } from "../../../../../src/server/content-flag-db";
import { guardContent } from "../../../../../src/server/content-guard";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

/** Add a past sale to the portfolio: { suburb, propertyType?, soldOn: YYYY-MM-DD, priceCents?, note? }. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const input: unknown = await req.json().catch(() => null);
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? String(o[k]) : "");
  // The suburb, property type and note are public on the agent's profile. Refused text is not saved.
  const g = await guardContent(createPgContentFlagStore(getDb()), { source: "profile", subjectType: "agent_portfolio", userId: actor.userId,
    fields: { suburb: str("suburb"), propertyType: str("propertyType"), note: str("note") } });
  if (!g.ok) return failure({ ok: false, code: "invalid", message: g.message });
  const r = await addPortfolioItem(getMarketplaceDb(), actor, input, marketplaceNow());
  if (r.ok) await g.after(r.value.id);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
