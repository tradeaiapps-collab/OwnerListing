import { NextResponse } from "next/server";
import { approveSummary, generateSummary } from "../../../../../src/domain/inspection";
import { withinLimit } from "../../../../../src/domain/rate-limit";
import { hashToken } from "../../../../../src/domain/offer-intake";
import { windowStart } from "../../../../../src/domain/rate-limit";
import { getAiEngine } from "../../../../../src/server/ai";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getInspectionRepo, inspectionIds } from "../../../../../src/server/inspection-db";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Per user: Elena's summaries run on our GPU, so they are limited. */
const SUMMARY_RATE = { windowMs: 60 * 60 * 1000, perUser: 20 } as const;

/**
 * Body: { action: "generate" } (Elena writes a draft summary; falls back to a plain rules summary when the AI is off) or
 * { action: "approve" } (a person approves it so shared viewers can read it). Inspector, owner or appointed agent.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body = await req.json().catch(() => null) as { action?: unknown } | null;
  const repo = getInspectionRepo();
  if (body?.action === "approve") {
    const r = await approveSummary(repo, actor, id, inspectionIds);
    return r.ok ? NextResponse.json(r.value) : failure(r);
  }
  if (body?.action !== "generate") return NextResponse.json({ error: "Choose generate or approve." }, { status: 400 });
  try {
    const hits = await countHitPg(getDb(), await hashToken(`inspection-summary:${actor.userId}`), windowStart(inspectionIds.now(), SUMMARY_RATE.windowMs));
    if (!withinLimit(hits, SUMMARY_RATE.perUser)) return NextResponse.json({ error: "Too many summaries. Try again later." }, { status: 429 });
  } catch {
    return NextResponse.json({ error: "Summaries are unavailable right now. Try again later." }, { status: 503 });
  }
  const r = await generateSummary(repo, await getAiEngine(), actor, id, inspectionIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
