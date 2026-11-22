import { NextResponse } from "next/server";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { recordOverallFeedbackPg } from "../../../../../src/server/elena-wiring-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Optional "Was Elena helpful?" after a settlement ends or a dispute is agreed or resolved.
 * Body: { kind: "settlement" | "dispute", subjectId, helpful?: "yes"|"partial"|"no", rating?: 1-5 }. Only the buyer or the owner of that sale can answer.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const kind = b?.["kind"], subjectId = b?.["subjectId"], helpful = b?.["helpful"], rating = b?.["rating"];
  const bad = { ok: false, code: "invalid", message: "Say whether it helped (yes, partial or no) or give a rating from 1 to 5." } as const;
  if ((kind !== "settlement" && kind !== "dispute") || !isUuid(subjectId)) return failure({ ok: false, code: "not_found", message: "Not found." });
  if (helpful !== undefined && helpful !== "yes" && helpful !== "partial" && helpful !== "no") return failure(bad);
  if (rating !== undefined && !(typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5)) return failure(bad);
  if (helpful === undefined && rating === undefined) return failure(bad);
  const r = await recordOverallFeedbackPg(getDb(), actor.userId, kind, subjectId, { ...(helpful ? { helpful } : {}), ...(rating !== undefined ? { rating: rating as number } : {}) });
  if (r === "not_found") return failure({ ok: false, code: "not_found", message: "Not found." });
  if (r === "not_ended") return failure({ ok: false, code: "conflict", message: "You can answer once it has ended." });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
