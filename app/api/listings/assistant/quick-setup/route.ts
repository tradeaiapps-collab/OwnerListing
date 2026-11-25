import { NextResponse } from "next/server";
import { checkElenaInput } from "../../../../../src/domain/text-quality";

import { buildQuickSetup, MAX_QUICK_NOTES } from "../../../../../src/domain/quick-setup";
import { AI_DESCRIPTION_RATE, withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { withApi } from "../../../../../src/server/api/with-api";
import { getAiEngine } from "../../../../../src/server/ai";
import { getDb } from "../../../../../src/server/context";
import { assistantGate } from "../../../../../src/server/listing-assistant";
import { countHitPg } from "../../../../../src/server/offer-flow-db";

/**
 * Quick setup. Body: { notes, transactionType?: "sale" | "rent" }. Returns the listing fields Elena read from the owner's notes
 * (title, description, type, location, rooms, price, features). Nothing is saved: the form is filled in and the owner reviews it.
 * Works with the AI off (rules only); with it on, the model only writes the title and description. Rate limited per user.
 */
async function handlePost(req: Request) {
  const gate = await assistantGate(req, "json");
  if (gate instanceof NextResponse) return gate;
  const b = gate.body as Record<string, unknown>;
  const notes = b["notes"];
  if (typeof notes !== "string" || notes.length > MAX_QUICK_NOTES) return NextResponse.json({ error: `Notes must be text of up to ${MAX_QUICK_NOTES} characters.` }, { status: 400 });
  const badNotes = checkElenaInput(notes);
  if (badNotes) return NextResponse.json({ error: badNotes }, { status: 400 });
  const tx = b["transactionType"];
  if (tx !== undefined && tx !== "sale" && tx !== "rent") return NextResponse.json({ error: "transactionType must be sale or rent." }, { status: 400 });
  const hits = await countHitPg(getDb(), `ai-desc:${gate.actor.userId}`, windowStart(new Date().toISOString(), AI_DESCRIPTION_RATE.windowMs));
  if (!withinLimit(hits, AI_DESCRIPTION_RATE.perUser)) return NextResponse.json({ error: "Too many suggestions. Try again later." }, { status: 429 });
  const result = await buildQuickSetup(await getAiEngine(), notes, tx);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
