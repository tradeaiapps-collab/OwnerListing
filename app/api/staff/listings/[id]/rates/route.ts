import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { parseRates, toRatesView, type ListingRates } from "../../../../../../src/domain/listing-rates";
import { staffCan } from "../../../../../../src/domain/staff-access";
import { appendAuditPg } from "../../../../../../src/server/db";
import { getDb, getDeps, getStaff } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { getRatesPg, saveRatesPg } from "../../../../../../src/server/listing-rates-db";
import { getRatesProvider } from "../../../../../../src/server/rates-provider";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "cache-control": "no-store" };

async function authorise(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return { err: NextResponse.json({ error: "Sign in as staff." }, { status: 401 }) };
  if (!staffCan(staff, "feeds.manage")) return { err: NextResponse.json({ error: "Not allowed." }, { status: 403 }) };
  return { staff };
}

/** Current rates for any sale listing, plus what the imported data holds for its address. feeds.manage only. */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await authorise(req);
  if (a.err) return a.err;
  const { id } = await params;
  const l = (await getDeps().repo.get(id))?.listing;
  if (!l || l.transactionType !== "sale") return NextResponse.json({ error: "Sale listing not found." }, { status: 404 });
  const db = getDb();
  const rates = (await getRatesPg(db, id)) ?? {};
  const rec = await getRatesProvider(db).lookup({ state: l.jurisdiction, address: l.address });
  return NextResponse.json({ address: l.address, rates, view: toRatesView(rates), available: rec ? { rates: rec.rates, source: rec.source, asAt: rec.asAt } : null }, { headers: NO_STORE });
}

/**
 * Staff set a sale listing's rates: { council?, water?, waterUsageBilledSeparately?, asAt, source } or { fromImport: true } to copy the imported
 * figures for the listing's address. The source (3 to 120 characters) is stored and shown to buyers. Audited without amounts. feeds.manage only.
 */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const a = await authorise(req);
  if (a.err) return a.err;
  const { id } = await params;
  const deps = getDeps();
  const l = (await deps.repo.get(id))?.listing;
  if (!l || l.transactionType !== "sale") return NextResponse.json({ error: "Sale listing not found." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the rates as an object." }, { status: 400 });
  const db = getDb();
  const now = deps.now();
  let value: ListingRates;
  if (body["fromImport"] === true) {
    const rec = await getRatesProvider(db).lookup({ state: l.jurisdiction, address: l.address });
    if (!rec) return NextResponse.json({ error: "No imported figures match this address." }, { status: 404 });
    value = { ...rec.rates, asAt: rec.asAt, source: { kind: "import", name: rec.source } };
  } else {
    const source = typeof body["source"] === "string" ? body["source"].trim() : "";
    if (source.length < 3 || source.length > 120) return NextResponse.json({ error: "Name where the figures came from (3 to 120 characters)." }, { status: 400 });
    const { source: _ignored, ...rest } = body;
    const parsed = parseRates(rest, now.slice(0, 10));
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400 });
    value = { ...parsed.value, source: { kind: "staff", name: source } };
  }
  const save = async (q: typeof db) => {
    await saveRatesPg(q, id, value, a.staff!.id, now);
    await appendAuditPg(q, {
      id: randomUUID(), occurredAt: now, actorType: "user", actorId: a.staff!.id, aggregateType: "property_listing", aggregateId: id,
      eventType: "listing.rates_set_by_staff", correlationId: randomUUID(), payload: { sourceKind: value.source?.kind, council: !!value.council, water: !!value.water }
    });
  };
  if (db.transaction) await db.transaction(save); else await save(db);
  return NextResponse.json({ rates: value, view: toRatesView(value) }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
