import { NextResponse } from "next/server";
import { listDocuments, readDocumentFile } from "../../../../../src/domain/document-service";
import { findingsParagraph, readInspectionReport, type ReportFinding } from "../../../../../src/domain/inspection-findings";
import { AI_DESCRIPTION_RATE, withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { withApi } from "../../../../../src/server/api/with-api";
import { getAiEngine } from "../../../../../src/server/ai";
import { getActor, getDb, getDeps, getUploadPorts } from "../../../../../src/server/context";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { extractPdfText } from "../../../../../src/server/pdf-pages";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Elena's reading of the listing's building and pest inspection reports. Owner only. Every finding is checked against the report text
 * before it is returned; nothing is saved and nothing reaches the description unless the owner adds it.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const deps = getDeps(), store = createPgDocumentStore(getDb());
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const docs = await listDocuments(deps, store, actor, id);
  if (!docs.ok) return failure(docs);
  const reports = docs.value.filter(d => d.status === "active" && (d.kind === "building_inspection" || d.kind === "pest_report"));
  if (reports.length === 0) return NextResponse.json({ state: "none", findings: [], paragraph: "" });
  const hits = await countHitPg(getDb(), `ai-desc:${actor.userId}`, windowStart(new Date().toISOString(), AI_DESCRIPTION_RATE.windowMs));
  if (!withinLimit(hits, AI_DESCRIPTION_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });

  const engine = await getAiEngine(), { storage } = getUploadPorts();
  const findings: ReportFinding[] = [];
  let state: "ok" | "no_text" | "unavailable" = "no_text";
  for (const d of reports.slice(0, 3)) {
    const file = await readDocumentFile(deps, store, storage, actor, d.id);
    if (!file.ok || file.value.contentType !== "application/pdf") continue;
    const r = await readInspectionReport(engine, await extractPdfText(file.value.bytes));
    if (r.state === "ok") { state = "ok"; findings.push(...r.findings); }
    else if (r.state === "unavailable" && state !== "ok") state = "unavailable";
  }
  return NextResponse.json({ state, reports: reports.length, findings, paragraph: findingsParagraph(findings) });
}

export const GET = withApi(handleGet);
