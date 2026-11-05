import { NextResponse } from "next/server";
import { hashToken } from "../../../../src/domain/offer-intake";
import { SEARCH_ASSIST_RATE, windowStart, withinLimit } from "../../../../src/domain/rate-limit";
import { getAiEngine } from "../../../../src/server/ai";
import { clientIp } from "../../../../src/server/client-ip";
import { getDb, getDeps } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { countHitPg } from "../../../../src/server/offer-flow-db";
import { runSearchAssist } from "../../../../src/server/search-assist-service";
import { withApi } from "../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY = 2048;

/**
 * Elena's search help (public). Rate limited per client IP hash before anything else; if the counter cannot be read the request is refused.
 * PRIVACY: what the visitor types is used to build filters and then dropped. It is not stored or logged.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  try {
    const hits = await countHitPg(getDb(), await hashToken(`search-assist:ip:${clientIp(req)}`), windowStart(new Date().toISOString(), SEARCH_ASSIST_RATE.windowMs));
    if (!withinLimit(hits, SEARCH_ASSIST_RATE.perIp)) return NextResponse.json({ error: "Too many questions. Try again in a few minutes." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "600" } });
  } catch {
    return NextResponse.json({ error: "Search help is unavailable right now." }, { status: 503, headers: NO_STORE });
  }
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "That is too long." }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Send a JSON object." }, { status: 400, headers: NO_STORE }); }
  const r = await runSearchAssist(body, getDeps(), await getAiEngine());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export const POST = withApi(handlePost);
