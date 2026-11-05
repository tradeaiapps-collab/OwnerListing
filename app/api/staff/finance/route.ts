import { NextResponse } from "next/server";
import { analyzePaymentPatterns, buildFinanceReport, trendCsv } from "../../../../src/domain/finance-report";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../src/server/context";
import { FINANCE_DAYS, loadFinanceRaw } from "../../../../src/server/finance-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Finance dashboard: revenue, GST, transactions, MRR, failures, overdue, trend and Elena's insights. ?days=7|30|90|365 (default 30), ?format=csv
 * for the monthly trend. report.financial only. Totals only: no customer names, emails or card data.
 */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "report.financial")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const url = new URL(req.url);
  const d = Number(url.searchParams.get("days") ?? 30);
  if (!(FINANCE_DAYS as readonly number[]).includes(d)) return NextResponse.json({ error: "days must be 7, 30, 90 or 365." }, { status: 400 });
  const raw = await loadFinanceRaw(getDb(), d);
  const report = buildFinanceReport(raw, new Date().toISOString());
  if (url.searchParams.get("format") === "csv") {
    return new NextResponse(trendCsv(report), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="revenue-by-month.csv"', "cache-control": "no-store" } });
  }
  return NextResponse.json({ report, insights: analyzePaymentPatterns(report, raw.monthlyPrices), canManage: staffCan(staff, "billing.manage") }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
