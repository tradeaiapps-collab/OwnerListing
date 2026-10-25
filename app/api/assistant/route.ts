import { NextResponse } from "next/server";
import { GUIDE_LIMITS, isGuideIntent, matchIntent, selectAssistantEngine, type GuideUser } from "../../../src/domain/guide-assistant";
import { nextStep } from "../../../src/domain/journey";
import { hashToken } from "../../../src/domain/offer-intake";
import { GUIDE_RATE, windowStart, withinLimit } from "../../../src/domain/rate-limit";
import { getAiEngine } from "../../../src/server/ai";
import { clientIp } from "../../../src/server/client-ip";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { devLoginAllowed } from "../../../src/server/dev-login";
import { getLiveGuide } from "../../../src/server/guide-assistant-db";
import { loadJourney } from "../../../src/server/journey";
import { countHitPg } from "../../../src/server/offer-flow-db";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY = 2048;
const err = (status: number, error: string, extra: Record<string, string> = {}) => NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...extra } });

/**
 * One question to the guide. Body: { intent?: topic id, text?: up to 500 characters, path: the page the visitor is on }.
 * PRIVACY: the typed text is used to pick an answer and then dropped. It is never stored, logged or put in the audit log.
 * Rate limited per client IP hash before anything else; if the counter cannot be read the request is refused (fail closed).
 * The answer can only describe the visitor's own next step (from their own records); it never contains other users' data.
 */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const db = getDb();
  try {
    const hits = await countGuideHit(db, req);
    if (!withinLimit(hits, GUIDE_RATE.perIp)) return err(429, "Too many questions. Try again in a few minutes.", { "Retry-After": "600" });
  } catch {
    return err(503, "The guide is unavailable right now.");
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return err(413, "The question is too long.");
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return err(413, "The question is too long.");
  let body: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return err(400, "Send a JSON object.");
    body = v as Record<string, unknown>;
  } catch {
    return err(400, "Send a JSON object.");
  }
  const intent = body["intent"], text = body["text"], path = body["path"];
  if (intent !== undefined && !isGuideIntent(intent)) return err(400, "Unknown topic.");
  if (text !== undefined && (typeof text !== "string" || text.length > GUIDE_LIMITS.message)) return err(400, `Questions can be up to ${GUIDE_LIMITS.message} characters.`);
  if (intent === undefined && (typeof text !== "string" || text.trim() === "")) return err(400, "Ask a question or choose a topic.");
  const page = typeof path === "string" && path.startsWith("/") && path.length <= 300 ? path : "/";

  const content = await getLiveGuide();
  if (!content.enabled) return err(404, "The guide is switched off.");
  const actor = await getActor(req).catch(() => null);
  const user: GuideUser = !actor ? "signed_out" : actor.userType === "buyer" ? "buyer" : actor.userType === "agent" ? "agent" : "owner";
  let next = null;
  const topic = intent ?? matchIntent(text);
  if (actor && topic === "next_step") {
    const j = await loadJourney(db, actor).catch(() => null);
    next = j ? nextStep(j.steps) : null;
  }
  const signInHref = devLoginAllowed(req) ? "/dev-login" : undefined;
  const engine = selectAssistantEngine(getAiEngine(), content);
  const answer = await engine.answer({
    ...(isGuideIntent(topic) ? { intent: topic } : {}), ...(typeof text === "string" ? { text: text.trim() } : {}),
    path: page, user, next, ...(signInHref ? { signInHref } : {})
  });
  return NextResponse.json(answer, { headers: NO_STORE });
}

async function countGuideHit(db: ReturnType<typeof getDb>, req: Request): Promise<number | undefined> {
  return countHitPg(db, await hashToken(`guide:ip:${clientIp(req)}`), windowStart(new Date().toISOString(), GUIDE_RATE.windowMs));
}
