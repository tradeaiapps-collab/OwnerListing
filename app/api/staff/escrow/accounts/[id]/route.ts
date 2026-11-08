import { NextResponse } from "next/server";
import { parseStatementCsv, reconciliationSummary, suggestFor } from "../../../../../../src/domain/deposit-escrow";
import { getDb } from "../../../../../../src/server/context";
import { accountLedger, importStatement } from "../../../../../../src/server/deposit-escrow-db";
import { fail, readJsonObject, staffAudit, staffGate, staffGateAny, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const MAX_CSV_CHARS = 1_000_000;

/** Reconciliation for one trust account: bank lines with a suggested match each, ledger entries without bank evidence, and totals. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGateAny(req, ["escrow.manage", "escrow.approve"]);
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Trust account not found.");
  const { lines, movements, holdings } = await accountLedger(getDb(), id);
  if (holdings.length === 0) return fail(404, "No deposit is held in that trust account.");
  const refs = new Map(holdings.map(h => [h.id, h.reference]));
  await staffAudit(staff, "trust_account", id, "escrow.reconciliation_viewed", { lines: lines.length });
  return NextResponse.json({
    summary: reconciliationSummary(movements, lines),
    lines: lines.map(l => ({ ...l, suggestion: suggestFor(l, holdings, movements) })),
    unmatched: movements.filter(m => !m.reconciled).map(m => ({ ...m, reference: refs.get(m.holdingId) ?? "" }))
  }, { headers: { "cache-control": "no-store" } });
}

/** Imports a bank statement CSV for this trust account. Body: { csv, fileName? }. Lines already imported are skipped. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "escrow.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Trust account not found.");
  const body = await readJsonObject(req);
  const csv = body?.["csv"];
  if (typeof csv !== "string" || !csv.trim()) return fail(400, "Attach the bank statement CSV.");
  if (csv.length > MAX_CSV_CHARS) return fail(413, "The statement is too large. Export a shorter date range.");
  const name = typeof body?.["fileName"] === "string" ? (body["fileName"] as string).slice(0, 200) : null;
  const parsed = parseStatementCsv(csv);
  const r = await importStatement(getDb(), staff, id, name, parsed);
  return r.ok ? NextResponse.json({ ...r.value, unreadable: parsed.errors.slice(0, 20) }, { status: 201 }) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
