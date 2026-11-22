import { NextResponse } from "next/server";
import { MAX_IMPORT_BYTES, METRICS, parseImportMeta, parseSuburbCsv, toSuburbView } from "../../../../src/domain/suburb-data";
import { staffCan } from "../../../../src/domain/staff-access";
import { appendAuditPg } from "../../../../src/server/db";
import { getDb, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { importSuburbsPg, listSuburbsPg } from "../../../../src/server/suburb-data-db";
import { withApi } from "../../../../src/server/api/with-api";
import { randomUUID } from "node:crypto";

const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });
const NO_STORE = { "cache-control": "no-store" };

/** Suburbs already loaded, newest first, with a text search (suburb or postcode). feeds.manage only. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 80);
  const { rows, total } = await listSuburbsPg(getDb(), q);
  return NextResponse.json({
    total, columns: ["state", "suburb", "postcode", ...METRICS.map(m => m.column)],
    suburbs: rows.map(r => ({ state: r.state, suburb: r.suburb, postcode: r.postcode, source: r.source, asAt: r.asAt, updatedAt: r.updatedAt, facts: toSuburbView(r)?.facts ?? [] }))
  }, { headers: NO_STORE });
}

/**
 * Imports a CSV: { source, asAt, csv }. All or nothing: any bad line rejects the whole file with up to 20 line errors (400, nothing saved).
 * A suburb already loaded is replaced by the file's row. Audited without the figures. feeds.manage only.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body["csv"] !== "string") return NextResponse.json({ error: "Send the CSV text as csv." }, { status: 400 });
  if ((body["csv"] as string).length > MAX_IMPORT_BYTES) return NextResponse.json({ error: "The file is too large. Split it into files under 400 KB." }, { status: 413 });
  const now = new Date().toISOString();
  const meta = parseImportMeta(body["source"], body["asAt"], now.slice(0, 10));
  if (!meta.ok) return NextResponse.json({ error: meta.message }, { status: 400 });
  const parsed = parseSuburbCsv(body["csv"] as string);
  if (!parsed.ok) return NextResponse.json({ error: "The file was not imported. Fix these lines and try again.", lines: parsed.errors }, { status: 400 });
  const db = getDb();
  const importId = randomUUID();
  const r = await importSuburbsPg(db, parsed.rows, { source: meta.source, asAt: meta.asAt, userId: staff.id, now, importId });
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "suburb_import", aggregateId: importId,
    eventType: "suburb_data.imported", correlationId: randomUUID(), payload: { source: meta.source, asAt: meta.asAt, suburbs: parsed.rows.length, created: r.created }
  });
  return NextResponse.json({ imported: parsed.rows.length, created: r.created, updated: r.updated }, { status: 201, headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
