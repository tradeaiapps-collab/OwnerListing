import { NextResponse } from "next/server";
import { personaById } from "../../../../src/domain/assistant-persona";
import { buildExtended, extendedAnswer } from "../../../../src/domain/market-forecast";
import { getDb } from "../../../../src/server/context";
import { loadDemandFacts } from "../../../../src/server/market-intel-db";
import { csrfGuard } from "../../../../src/server/csrf";
import { getLivePersona } from "../../../../src/server/assistant-persona-db";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

const MAX_BODY = 4096;
const MAX_QUESTION = 500;

/**
 * Ask the assistant about a property search. Body: the same fields as the other intelligence routes plus `question` (up to 500 characters).
 * She answers from the figures only (method, confidence, trends, market, comparables, report, forecast, fundamentals, buyer demand, value breakdown); she gives no advice and cannot change a number.
 * The question is used to pick the answer and is not stored.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
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
  if (question.length > MAX_QUESTION) return NextResponse.json({ error: `Questions can be up to ${MAX_QUESTION} characters.` }, { status: 400, headers: noStore });
  const field = (k: string) => { const v = body[k]; return typeof v === "string" || typeof v === "number" ? v : null; };
  const ctx = await loadIntel(req, field);
  if (ctx instanceof NextResponse) return ctx;
  const bundle = buildBundle(ctx.query, ctx.comps, ctx.now);
  const demand = await loadDemandFacts(getDb(), ctx.query, ctx.now).catch(() => undefined);
  const answer = extendedAnswer(bundle, buildExtended(ctx.query, ctx.comps, ctx.now, bundle, demand), question);
  const persona = personaById(await getLivePersona());
  return NextResponse.json({ persona: { name: persona.name, icon: persona.icon }, ...answer }, { headers: noStore });
}

export const POST = withApi(handlePost);
