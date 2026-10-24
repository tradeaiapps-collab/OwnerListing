import { NextResponse } from "next/server";
import { compareOffers, REPORT_NOTE, requestAiSummary, type AiSummary } from "../../../../../src/domain/offer-analysis";
import { getAiEngine } from "../../../../../src/server/ai";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { offersForOwnerPg } from "../../../../../src/server/offers-db";
import { requireListingOwner } from "../../../../../src/server/owner-listing";

type Ctx = { params: Promise<{ id: string }> };

async function report(req: Request, id: string, withAi: boolean) {
  const owner = await requireListingOwner(req, id);
  if (owner instanceof NextResponse) return owner;
  const rows = compareOffers(await offersForOwnerPg(getDb(), id, owner.actor.userId));
  // The AI is asked only on POST, through the AI port. It can summarise; it has no way to decide anything.
  const ai: AiSummary = withAi ? await requestAiSummary(getAiEngine(), rows) : { state: "not_requested" };
  if (withAi) {
    const deps = getDeps();
    await deps.appendAudit({
      id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: owner.actor.userId,
      aggregateType: "listing", aggregateId: id, eventType: "offer_analysis.ai_requested",
      correlationId: deps.newId(), payload: { aiState: ai.state, offers: rows.length }
    });
  }
  return NextResponse.json({ rows, note: REPORT_NOTE, ai });
}

/** Owner-only deterministic comparison of the offers on a listing. No AI is called. Others get 404. */
export async function GET(req: Request, { params }: Ctx) {
  return report(req, (await params).id, false);
}

/** Owner asks for the optional AI summary. Same table, plus an AI state ("unavailable" while the engine is off). */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  return report(req, (await params).id, true);
}
