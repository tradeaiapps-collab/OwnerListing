import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { MAX_IMPORT_BYTES, parseImportMeta } from "../../../../src/domain/suburb-data";
import { parseRatesCsv, RATES_COLUMNS } from "../../../../src/domain/rates-provider";
import { toRatesView } from "../../../../src/domain/listing-rates";
import { staffCan } from "../../../../src/domain/staff-access";
import { appendAuditPg } from "../../../../src/server/db";
import { getDb, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { importAddressRatesPg, listAddressRatesPg } from "../../../../src/server/address-rates-db";
import { withApi } from "../../../../src/server/api/with-api";

const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });
const NO_STORE = { "cache-control": "no-store" };

/** Addresses already loaded, newest first, with a text search. feeds.manage only. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 80);
  const { rows, total } = await listAddressRatesPg(getDb(), q);
  return NextResponse.json({
    total, columns: RATES_COLUMNS,
    addresses: rows.map(r => ({ state: r.state, address: r.address, source: r.source, asAt: r.asAt, lines: toRatesView(r.rates)?.lines ?? [] }))
  }, { headers: NO_STORE });
}

/** Imports a CSV: { source, asAt, csv }. All or nothing (400 with up to 20 line errors). An address already loaded is replaced. Audited without amounts. */
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
  const parsed = parseRatesCsv(body["csv"] as string);
  if (!parsed.ok) return NextResponse.json({ error: "The file was not imported. Fix these lines and try again.", lines: parsed.errors }, { status: 400 });
  const db = getDb();
  const r = await importAddressRatesPg(db, parsed.rows, { source: meta.source, asAt: meta.asAt, userId: staff.id, now });
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "address_rates_import", aggregateId: randomUUID(),
    eventType: "address_rates.imported", correlationId: randomUUID(), payload: { source: meta.source, asAt: meta.asAt, addresses: parsed.rows.length, created: r.created }
  });
  return NextResponse.json({ imported: parsed.rows.length, created: r.created, updated: r.updated }, { status: 201, headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
