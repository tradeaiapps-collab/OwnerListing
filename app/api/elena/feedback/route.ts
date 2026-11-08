import { NextResponse } from "next/server";
import { isUuid } from "../../../../src/domain/offer-decision";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { recordFeedbackPg, suggestionOwnerPg } from "../../../../src/server/elena-learning-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * A person tells Elena how a suggestion went. Body: { suggestionId, helpful?: "yes"|"no"|"partial", rating?: 1-5 }.
 * Only the person the suggestion was made for can answer. "yes" counts as accepted, "partial" as modified, "no" as rejected.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = b?.["suggestionId"];
  const helpful = b?.["helpful"], rating = b?.["rating"];
  const bad = { ok: false, code: "invalid", message: "Say whether it helped (yes, partial or no) or give a rating from 1 to 5." } as const;
  if (!isUuid(id)) return failure({ ok: false, code: "not_found", message: "Suggestion not found." });
  if (helpful !== undefined && helpful !== "yes" && helpful !== "partial" && helpful !== "no") return failure(bad);
  if (rating !== undefined && !(typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5)) return failure(bad);
  if (helpful === undefined && rating === undefined) return failure(bad);
  const db = getDb();
  if ((await suggestionOwnerPg(db, id)) !== actor.userId) return failure({ ok: false, code: "not_found", message: "Suggestion not found." });
  const action = helpful === "no" ? "rejected" : helpful === "partial" ? "modified" : helpful === "yes" ? "accepted" : (rating as number) >= 4 ? "accepted" : (rating as number) <= 2 ? "rejected" : "modified";
  await recordFeedbackPg(db, { suggestionId: id, action, source: "user", recordedBy: actor.userId, ...(helpful ? { helpful } : {}), ...(rating !== undefined ? { rating: rating as number } : {}) });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
