import { NextResponse } from "next/server";
import { reportTable, type Insights, type ReportResult } from "../domain/agent-reports";
import { toCsv } from "../domain/reports";
import { toPdf, toXlsx } from "../domain/report-export";

const NO_STORE = { "cache-control": "no-store" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";

/** JSON, or a file download in CSV, Excel or PDF. Every format carries the same table and the same period. */
export function reportResponse(report: ReportResult, insights: Insights, format: string | null): NextResponse {
  if (format === null || format === "json") return NextResponse.json({ report, insights }, { headers: NO_STORE });
  const t = reportTable(report);
  const base = `${slug(report.title)}-${report.period.from}-to-${report.period.to}`;
  const headers = (type: string, ext: string) => ({ ...NO_STORE, "content-type": type, "content-disposition": `attachment; filename="${base}.${ext}"` });
  if (format === "csv") return new NextResponse(toCsv(t.head, t.rows), { headers: headers("text/csv; charset=utf-8", "csv") });
  if (format === "xlsx") return new NextResponse(toXlsx(t.head, t.rows, report.title) as BodyInit, { headers: headers("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx") });
  if (format === "pdf") {
    const sub = `${report.period.from} to ${report.period.to}, compared with ${report.previousPeriod.from} to ${report.previousPeriod.to}`;
    return new NextResponse(toPdf(report.title, sub, t.head, t.rows, [insights.headline, ...insights.points.map(p => `- ${p}`), "Summary by Elena, an AI assistant, from your own listings' numbers."]) as BodyInit, { headers: headers("application/pdf", "pdf") });
  }
  return NextResponse.json({ error: "Format must be json, csv, xlsx or pdf." }, { status: 400 });
}
