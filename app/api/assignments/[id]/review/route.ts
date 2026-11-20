import { NextResponse } from "next/server";
import { parseReview } from "../../../../../src/domain/contractor-trust";
import { createReviewPg } from "../../../../../src/server/contractor-trust-db";
import { err, guardText, ID_RE, readBody, sessionActor } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Only the owner of a completed job rates it, once: { "rating": 1-5, "comment"?: text }. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { write: true });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const v = parseReview(await readBody(req));
  if (!v.ok) return err(400, v.message);
  if (v.value.comment) {
    const g = await guardText(actor.userId, "contractor_review", { comment: v.value.comment });
    if ("response" in g) return g.response;
  }
  const out = await createReviewPg(getDb(), actor.userId, id, v.value);
  if (out === "not_allowed") return err(403, "Only the owner of a completed job can rate the contractor.");
  if (out === "duplicate") return err(409, "You have already rated this job.");
  return NextResponse.json({ ok: true }, { status: 201 });
}

export const POST = withApi(handlePost);
