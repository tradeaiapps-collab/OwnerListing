import { NextResponse } from "next/server";
import { isRewriteMode, MAX_REWRITE_INPUT, preferredRewriteMode, rewriteDescription } from "../../../../../src/domain/listing-assistant";
import { withApi } from "../../../../../src/server/api/with-api";
import { getDb } from "../../../../../src/server/context";
import { loadProfilePg } from "../../../../../src/server/listing-assistant-db";
import { assistantGate, parseFacts } from "../../../../../src/server/listing-assistant";

/**
 * Description rewriter. Body: { text, mode?: "better" | "shorter", facts? }. Returns the rewritten text, what changed, and nothing is
 * saved. Without a mode it uses the one the author prefers. The text is only tidied or trimmed, never extended with new claims.
 */
async function handlePost(req: Request) {
  const gate = await assistantGate(req, "json");
  if (gate instanceof NextResponse) return gate;
  const b = gate.body as Record<string, unknown>;
  const text = b["text"];
  if (typeof text !== "string" || text.length > MAX_REWRITE_INPUT) return NextResponse.json({ error: `Text must be up to ${MAX_REWRITE_INPUT} characters.` }, { status: 400 });
  if (b["mode"] !== undefined && !isRewriteMode(b["mode"])) return NextResponse.json({ error: "mode must be better or shorter." }, { status: 400 });
  const parsed = parseFacts(b["facts"] ?? { transactionType: "sale" });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const profile = await loadProfilePg(getDb(), gate.actor.userId);
  const mode = isRewriteMode(b["mode"]) ? b["mode"] : preferredRewriteMode(profile);
  return NextResponse.json(rewriteDescription(text, mode, parsed.facts, profile), { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
