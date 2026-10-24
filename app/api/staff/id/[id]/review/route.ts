import { NextResponse } from "next/server";
import { reviewId } from "../../../../../../src/domain/id-review-service";
import type { ReviewChecklist, ReviewOutcome } from "../../../../../../src/domain/id-verification";
import { fail } from "../../../../../../src/domain/listing-service";
import { getActor, getIdDeps } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";

const OUTCOMES: readonly string[] = ["approve", "reject", "needs_more"];
const STATUS_CHECKS: readonly string[] = ["done", "not_available", "failed"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const c = (b?.["checklist"] ?? {}) as Record<string, unknown>;
  if (!b || typeof b["outcome"] !== "string" || !OUTCOMES.includes(b["outcome"])) return failure(fail("invalid", "Choose an outcome."));
  const checklist: ReviewChecklist = {
    documentLooksGenuine: c["documentLooksGenuine"] === true,
    photoMatchesSelfie: c["photoMatchesSelfie"] === true,
    nameMatchesAccount: c["nameMatchesAccount"] === true,
    notExpired: c["notExpired"] === true,
    ...(typeof c["officialStatusCheck"] === "string" && STATUS_CHECKS.includes(c["officialStatusCheck"])
      ? { officialStatusCheck: c["officialStatusCheck"] as NonNullable<ReviewChecklist["officialStatusCheck"]> } : {})
  };
  const r = await reviewId(getIdDeps(), actor, id, b["outcome"] as ReviewOutcome, checklist);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
