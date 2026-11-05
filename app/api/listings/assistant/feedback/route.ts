import { NextResponse } from "next/server";
import { describeLearning, parseFeedback } from "../../../../../src/domain/listing-assistant";
import { withApi } from "../../../../../src/server/api/with-api";
import { getDb } from "../../../../../src/server/context";
import { insertFeedbackPg, loadProfilePg, resetFeedbackPg } from "../../../../../src/server/listing-assistant-db";
import { assistantGate } from "../../../../../src/server/listing-assistant";

/** What Elena has learned from this author, in plain sentences. */
async function handleGet(req: Request) {
  const gate = await assistantGate(req, "read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ learned: describeLearning(await loadProfilePg(getDb(), gate.actor.userId)) }, { headers: { "cache-control": "no-store" } });
}

/** Body: { events: [{ kind, key, action, deltaPct? }] }. Only fixed vocabulary is accepted; no free text is stored. */
async function handlePost(req: Request) {
  const gate = await assistantGate(req, "json");
  if (gate instanceof NextResponse) return gate;
  const parsed = parseFeedback((gate.body as Record<string, unknown>)["events"]);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  await insertFeedbackPg(getDb(), gate.actor.userId, parsed.events);
  return NextResponse.json({ saved: parsed.events.length });
}

/** The author asks Elena to forget what she learned from them. */
async function handleDelete(req: Request) {
  const gate = await assistantGate(req, "bare");
  if (gate instanceof NextResponse) return gate;
  await resetFeedbackPg(getDb(), gate.actor.userId);
  return NextResponse.json({ reset: true });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
export const DELETE = withApi(handleDelete);
