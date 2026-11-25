import { NextResponse } from "next/server";
import { checkElenaInput } from "../../../../src/domain/text-quality";

import { answerQuestion, needsMarketData, resolveSuburb, type BrainData, type ElenaAppContext } from "../../../../src/domain/elena-brain";
import { buildExtended } from "../../../../src/domain/market-forecast";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { noteSuggestion } from "../../../../src/server/elena-wiring-db";
import { loadDemandFacts } from "../../../../src/server/market-intel-db";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

const MAX_BODY = 4096;
const MAX_QUESTION = 500;
const ROLES = ["buyer", "owner", "agent", "investor", "other"] as const;

/**
 * Ask Elena anything about property. Body: { question (up to 500 characters), context?: { page, suburb, postcode, propertyType, role } }.
 * Signed-in users only. Knowledge questions are answered from the built-in knowledge base; suburb and market questions load the
 * platform's own sales and buyer activity (same limits as the other intelligence routes). She gives no advice.
 * The question text is used to pick the answer and is never stored; only the kind of answer is recorded for the learning loop
 * (and only with the person's training consent, which `noteSuggestion` checks). The reply carries `suggestionId` for POST /api/elena/feedback.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req).catch(() => null);
  if (!actor) return NextResponse.json({ error: "Sign in to ask Elena." }, { status: 401, headers: noStore });
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "The request is too long." }, { status: 413, headers: noStore });
  let body: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
    body = v as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send a JSON object." }, { status: 400, headers: noStore });
  }
  const question = body["question"];
  if (typeof question !== "string" || !question.trim()) return NextResponse.json({ error: "Type a question." }, { status: 400, headers: noStore });
  const badQuestion = checkElenaInput(question);
  if (badQuestion) return NextResponse.json({ error: badQuestion }, { status: 400, headers: noStore });
  if (question.length > MAX_QUESTION) return NextResponse.json({ error: `Questions can be up to ${MAX_QUESTION} characters.` }, { status: 400, headers: noStore });

  const c = typeof body["context"] === "object" && body["context"] !== null && !Array.isArray(body["context"]) ? (body["context"] as Record<string, unknown>) : {};
  const text = (k: string, max: number) => { const v = c[k]; return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined; };
  const role = ROLES.find((r) => r === c["role"]);
  const ctx: ElenaAppContext = {
    page: text("page", 200)?.startsWith("/") ? text("page", 200) : undefined, suburb: text("suburb", 80),
    postcode: /^\d{4}$/.test(text("postcode", 4) ?? "") ? text("postcode", 4) : undefined, role
  };

  const data: BrainData = {};
  const place = needsMarketData(question) ? resolveSuburb(question, ctx) : undefined;
  if (place) {
    const field = (k: string) => k === "suburb" ? place.suburb : k === "postcode" ? place.postcode ?? null : k === "propertyType" ? text("propertyType", 20) ?? "house" : k === "transactionType" ? "sale" : null;
    const intel = await loadIntel(req, field);
    if (intel instanceof NextResponse) return intel;
    const bundle = buildBundle(intel.query, intel.comps, intel.now);
    const demand = await loadDemandFacts(getDb(), intel.query, intel.now).catch(() => undefined);
    data.bundle = bundle;
    data.extended = buildExtended(intel.query, intel.comps, intel.now, bundle, demand);
  }

  const answer = answerQuestion(question, ctx, data);
  const suggestionId = answer.intent === "unknown" || answer.intent.startsWith("needs_") || answer.intent === "advice_declined"
    ? undefined
    : await noteSuggestion(getDb(), { feature: "other", type: answer.type, userId: actor.userId, userRole: actor.userType, source: "direct" });
  return NextResponse.json({ ...answer, ...(suggestionId ? { suggestionId } : {}) }, { headers: noStore });
}

export const POST = withApi(handlePost);
