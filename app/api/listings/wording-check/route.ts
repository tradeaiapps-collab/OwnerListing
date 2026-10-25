import { NextResponse } from "next/server";
import { scanForDiscrimination } from "../../../../src/domain/discrimination-filter";
import { MAX_DESCRIPTION_LENGTH } from "../../../../src/domain/listing-service";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";

/**
 * Live anti-discrimination check while an owner types a title, description or message. Body: { text }. Nothing is stored.
 * Signed-in users only, so the phrase list cannot be probed anonymously.
 */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body: unknown = await req.json().catch(() => null);
  const text = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["text"] : undefined;
  if (typeof text !== "string" || text.length > MAX_DESCRIPTION_LENGTH) {
    return NextResponse.json({ error: `Text must be up to ${MAX_DESCRIPTION_LENGTH} characters.` }, { status: 400 });
  }
  return NextResponse.json(scanForDiscrimination(text), { headers: { "cache-control": "no-store" } });
}
