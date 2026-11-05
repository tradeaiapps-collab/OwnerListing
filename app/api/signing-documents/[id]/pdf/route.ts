import { NextResponse } from "next/server";
import { buildSignedPdf } from "../../../../../src/domain/signing-pdf";
import { signedCopyData } from "../../../../../src/domain/signing-service";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getSigningRepo, signingIds } from "../../../../../src/server/signing-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The signed copy as a PDF, for the owner and the signers once everyone has signed. Anyone else gets 404; before then 409. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await signedCopyData(getSigningRepo(), actor, id);
  if (!r.ok) return failure(r);
  const bytes = buildSignedPdf(r.value.document, r.value.events, r.value.emails, signingIds.now());
  return new NextResponse(bytes as BodyInit, { headers: {
    "content-type": "application/pdf", "content-length": String(bytes.length), "content-disposition": `attachment; filename="signed-${r.value.document.id}.pdf"`,
    "x-content-type-options": "nosniff", "cache-control": "private, no-store"
  } });
}

export const GET = withApi(handleGet);
