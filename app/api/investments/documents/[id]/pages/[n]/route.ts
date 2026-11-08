import { NextResponse } from "next/server";
import { renderDocumentPage } from "../../../../../../../src/domain/project-document-masking";
import { withinLimit } from "../../../../../../../src/domain/rate-limit";
import { getActor, getDb, getMaskPorts } from "../../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../../src/server/investments-db";
import { invFailure, notFound, UUID } from "../../../../../../../src/server/investment-route";
import { pageImageResponse } from "../../../../../../../src/server/project-photo-route";
import { createPgProjectDocStore } from "../../../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../../../src/server/api/with-api";

/** Bulk page reads per person: enough to read many documents, not enough to scrape them all in minutes. */
const PAGE_READ_RATE = { windowMs: 10 * 60 * 1000, perUser: 240 } as const;

/**
 * One page of a document as a flat WebP image. Investors get the masked, watermarked page (and only once staff confirmed the masking).
 * The owner gets the original page; ?view=investor shows the owner what investors see. The original file is never sent.
 */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const deps = getInvestmentDeps();
  if (!(await deps.moduleState()).live) return notFound();
  const { id, n } = await params;
  if (!UUID.test(id) || !/^\d{1,3}$/.test(n)) return notFound();
  const actor = await getActor(req);
  if (!actor) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    if (!withinLimit(await deps.countHit(`doc-page:${actor.userId}`, PAGE_READ_RATE.windowMs), PAGE_READ_RATE.perUser)) {
      return NextResponse.json({ error: "Too many pages opened. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": "300" } });
    }
  } catch { return NextResponse.json({ error: "Documents are unavailable right now." }, { status: 503 }); }
  const asInvestor = new URL(req.url).searchParams.get("view") === "investor";
  const r = await renderDocumentPage(deps, createPgProjectDocStore(getDb()), getMaskPorts(), actor, id, Number(n), undefined, { asInvestor });
  return r.ok ? pageImageResponse(r.value.image, r.value.contentType) : invFailure(r);
}

export const GET = withApi(handleGet);
