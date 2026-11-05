import { NextResponse } from "next/server";
import { parseDocumentInput, translateDocument } from "../../../../../src/domain/multilingual-service";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getTranslateServiceDeps } from "../../../../../src/server/multilingual-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body: { text, kind: "offer" | "contract" | "inspection" | "other", to?, from? }. Translates the text for a party to the enquiry,
 * keeping layout, numbers and amounts exact. Nothing is stored. The English original is the one that applies.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure({ ok: false, code: "not_found", message: "Enquiry not found." });
  const input = parseDocumentInput(await req.json().catch(() => null));
  if (!input.ok) return failure(input);
  const r = await translateDocument(getTranslateServiceDeps(), actor, id, input.value);
  return r.ok ? NextResponse.json({ translation: r.value }) : failure(r);
}

export const POST = withApi(handlePost);
