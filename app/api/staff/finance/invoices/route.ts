import { NextResponse } from "next/server";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { INVOICE_FILTERS, listStaffInvoices, type InvoiceFilter } from "../../../../../src/server/finance-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Latest 100 invoices, ?filter=all|pending|overdue|paid|failed. Customers appear as a short reference only. report.financial. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "report.financial")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const f = new URL(req.url).searchParams.get("filter") ?? "all";
  if (!(INVOICE_FILTERS as readonly string[]).includes(f)) return NextResponse.json({ error: "Unknown filter." }, { status: 400 });
  return NextResponse.json({ invoices: await listStaffInvoices(getDb(), f as InvoiceFilter) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
