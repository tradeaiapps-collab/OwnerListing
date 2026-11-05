import { NextResponse } from "next/server";
import { translateEnquiryMessage } from "../../../../../../../src/domain/multilingual-service";
import { isUuid } from "../../../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { getTranslateServiceDeps } from "../../../../../../../src/server/multilingual-db";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; messageId: string }> };

// POST only. A translation never edits or replaces the message; it is shown beside it, labelled as machine translation.
/** Body (optional): { "to": "vi" }. Defaults to the reader's chat language. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, messageId } = await params;
  if (!isUuid(id) || !isUuid(messageId)) return failure({ ok: false, code: "not_found", message: "Message not found." });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await translateEnquiryMessage(getTranslateServiceDeps(), actor, id, messageId, body?.["to"]);
  return r.ok ? NextResponse.json({ translation: r.value }) : failure(r);
}

export const POST = withApi(handlePost);
