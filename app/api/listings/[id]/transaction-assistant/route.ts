import { NextResponse } from "next/server";
import { personaById } from "../../../../../src/domain/assistant-persona";
import { TXN_ASSISTANT_RATE, windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { hashToken } from "../../../../../src/domain/offer-intake";
import { summariseFindings } from "../../../../../src/domain/inspection";
import {
  DESK_LABELS, MAX_QUESTION, STAGE_LABELS, answerQuestion, insights, requestFindingsSummary, requirements
} from "../../../../../src/domain/transaction-assistant";
import { getAiEngine } from "../../../../../src/server/ai";
import { getLivePersona } from "../../../../../src/server/assistant-persona-db";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { findingsForInspections, inspectionsForListing, loadFacts } from "../../../../../src/server/transaction-db";
import { audit, isHandler, readJson, requireTxnAccess } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "cache-control": "no-store" } as const;

async function factsFor(a: Exclude<Awaited<ReturnType<typeof requireTxnAccess>>, NextResponse>) {
  const l = a.rec.listing;
  return loadFacts(getDb(), { id: l.id, status: l.status, transactionType: l.transactionType, jurisdiction: l.jurisdiction }, a.role, a.actor.userId);
}

/**
 * Overview for the assistant panel: the stage, what is required and missing, simple counts (the "insights") and a summary of the
 * inspection findings. Built only from what the signed-in person can already see on this listing.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await requireTxnAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const f = await factsFor(a);
  return NextResponse.json({
    persona: await getLivePersona().then(id => { const p = personaById(id); return { id: p.id, name: p.name }; }).catch(() => ({ id: "elena", name: "Elena" })),
    stage: f.stage, stageLabel: STAGE_LABELS[f.stage], requirements: requirements(f), insights: insights(f), findings: summariseFindings(f.findings)
  }, { headers: NO_STORE });
}

/**
 * Body: { question } for an answer from the right desk, or { aiSummary: true } for the optional AI summary of the findings
 * (self-hosted model only; otherwise "unavailable"). Questions are rate limited per person and are not stored.
 * She never signs, sends or decides anything, and the AI text is checked before it is shown.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const a = await requireTxnAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const body = await readJson(req, 2048);
  if (body instanceof NextResponse) return body;
  const wantsAi = body["aiSummary"] === true;
  const q = body["question"];
  if (!wantsAi && (typeof q !== "string" || !q.trim() || q.length > MAX_QUESTION)) return NextResponse.json({ error: `Ask a question of up to ${MAX_QUESTION} characters.` }, { status: 400 });
  try {
    const bucket = await hashToken(`txn:${wantsAi ? "ai" : "q"}:${a.actor.userId}`);
    const hits = await countHitPg(getDb(), bucket, windowStart(getDeps().now(), TXN_ASSISTANT_RATE.windowMs));
    if (!withinLimit(hits, wantsAi ? TXN_ASSISTANT_RATE.aiSummaryPerUser : TXN_ASSISTANT_RATE.perUser)) {
      return NextResponse.json({ error: "Too many questions. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "600" } });
    }
  } catch {
    return NextResponse.json({ error: "The assistant is unavailable right now." }, { status: 503 });
  }
  if (wantsAi) {
    const insp = await inspectionsForListing(getDb(), a.rec.listing.id, isHandler(a.role) ? { all: true } : { userId: a.actor.userId });
    const findings = await findingsForInspections(getDb(), insp.filter(i => i.status === "completed").map(i => i.id));
    const ai = await requestFindingsSummary(await getAiEngine(), findings);
    await audit("transaction_assistant.ai_summary", "listing", a.rec.listing.id, a.actor.userId, { state: ai.state, findings: findings.length });
    return NextResponse.json({ ai }, { headers: NO_STORE });
  }
  const answer = answerQuestion(await factsFor(a), q as string);
  return NextResponse.json({ answer: { ...answer, deskLabel: DESK_LABELS[answer.desk] } }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
