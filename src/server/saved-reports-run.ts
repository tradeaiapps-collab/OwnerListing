import { randomUUID } from "node:crypto";
import { ANALYTICS_TIME_ZONE } from "../domain/admin-analytics";
import { reportInsights, formatMeasure, type Insights } from "../domain/report-insights";
import { buildResult, measureOf, nextRunAfter, parseDefinition, previousPeriod, resolvePeriod, type ReportDefinition, type ReportResult } from "../domain/saved-reports";
import { staffCan, type StaffActor } from "../domain/staff-access";
import { localDateInZone } from "../domain/timezone";
import { attachmentFileName, attachmentNote, fitAttachments, type EmailAttachment } from "../domain/report-attachments";
import { CONTENT_TYPES, exportReport } from "../domain/saved-report-export";
import { readBrand } from "../config/brand";
import { loadReport } from "./admin-report-builder-db";
import { appendAuditPg, type Queryable } from "./db";
import { getEmailPort } from "./messaging";
import { claimSchedule, dueSchedules, finishSchedule, recordRun } from "./saved-reports-db";
import { loadStaffActor } from "./staff-auth";

type Env = Readonly<Record<string, string | undefined>>;

/** Runs a definition as this staff member (their permissions decide revenue and agent names), now. */
export async function executeReport(db: Queryable, actor: StaffActor, def: ReportDefinition, nowIso: string): Promise<{ result: ReportResult; insights: Insights }> {
  const range = resolvePeriod(def, localDateInZone(nowIso, ANALYTICS_TIME_ZONE));
  const dimension = def.dimension;
  const raw = await loadReport(db, { range, dimension });
  let prev: { range: typeof range; raw: typeof raw } | undefined;
  if (def.compare) { const pr = previousPeriod(def, range); prev = { range: pr, raw: await loadReport(db, { range: pr, dimension }) }; }
  const result = buildResult(actor, def, range, raw, prev, nowIso);
  return { result, insights: reportInsights(result) };
}

/** Plain-text body of a scheduled report: Elena's summary, the top rows, and a link to the full report. */
export function reportEmail(result: ReportResult, insights: Insights, appUrl: string | undefined, reportId: string, note = ""): { subject: string; text: string } {
  const link = appUrl ? `${appUrl.replace(/\/+$/, "")}/staff/report-builder?report=${encodeURIComponent(reportId)}` : "";
  const lines = [`${result.name}`, `${result.range.from} to ${result.range.to}`, "", `Elena's summary: ${insights.headline}`, ...insights.points.map(p => `- ${p}`), ""];
  const top = result.rows.slice(0, 10);
  for (const r of top) lines.push(`${r.label}: ${result.measures.map(m => `${measureOf(m).label} ${formatMeasure(m, r.values[m] ?? 0)}`).join(", ")}`);
  if (result.rows.length > top.length) lines.push(`...and ${result.rows.length - top.length} more.`);
  lines.push("", `Total: ${result.measures.map(m => `${measureOf(m).label} ${formatMeasure(m, result.totals[m] ?? 0)}`).join(", ")}`);
  if (note) lines.push("", note);
  if (link) lines.push("", `Open the full report, with CSV, Excel and PDF downloads: ${link}`);
  lines.push("", `You are receiving this because you scheduled this report on ${readBrand().name}. Change or stop it from the report builder.`);
  return { subject: `${result.name}: ${result.range.from} to ${result.range.to}`, text: lines.join("\n") + "\n" };
}

/** The PDF and Excel files for an emailed report; any that would push the total past 25 MB are left out and the email says so. */
export function reportAttachments(result: ReportResult, insights: Insights, nowIso: string): { attachments: EmailAttachment[]; skipped: number } {
  const sentOn = localDateInZone(nowIso, ANALYTICS_TIME_ZONE);
  return fitAttachments((["pdf", "xlsx"] as const).map(f => ({
    filename: attachmentFileName(result.name, result.range.from, result.range.to, sentOn, f), content: exportReport(result, f, insights), contentType: CONTENT_TYPES[f]
  })));
}

export interface RunCounts { due: number; sent: number; notConfigured: number; failed: number; skipped: number }

/**
 * Runs every schedule that is due, each as its owner with the owner's permissions right now. A schedule is claimed before it runs, so two
 * overlapping ticks never send twice. An owner who lost report access (or left) has the schedule switched off. The report goes to the owner's own email only.
 */
export async function runDueReports(db: Queryable, nowIso: string, env: Env, limit = 20): Promise<RunCounts> {
  const due = await dueSchedules(db, nowIso, limit);
  const counts: RunCounts = { due: due.length, sent: 0, notConfigured: 0, failed: 0, skipped: 0 };
  for (const d of due) {
    if (!(await claimSchedule(db, d, nextRunAfter(d.schedule, nowIso)))) { counts.skipped++; continue; }
    let status: "sent" | "not_configured" | "failed" | "owner_no_access" = "failed";
    try {
      const actor = await loadStaffActor(db, d.ownerId);
      const parsed = actor && staffCan(actor, "report.sales") ? parseDefinition(d.definition, actor, { scheduled: true }) : null;
      if (!actor || !parsed || !parsed.ok) { status = "owner_no_access"; counts.skipped++; }
      else {
        const { result, insights } = await executeReport(db, actor, parsed.definition, nowIso);
        await recordRun(db, d.reportId, "schedule", d.ownerId, result, insights);
        const port = await getEmailPort(db, env, "scheduled_report");
        if (!port.configured || !d.ownerEmail) { status = "not_configured"; counts.notConfigured++; }
        else {
          const { attachments, skipped } = reportAttachments(result, insights, nowIso);
          const msg = reportEmail(result, insights, env["APP_URL"], d.reportId, attachmentNote(attachments, skipped));
          status = (await port.send({ to: d.ownerEmail, ...msg, ...(attachments.length ? { attachments } : {}) })).status === "sent" ? "sent" : "failed";
          if (status === "sent") counts.sent++; else counts.failed++;
        }
      }
    } catch {
      status = "failed"; counts.failed++;
    }
    await finishSchedule(db, d.reportId, status, nowIso);
  }
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: nowIso, actorType: "system", actorId: "scheduled-reports", aggregateType: "job", aggregateId: "scheduled-reports",
    eventType: "job.scheduled_reports_run", correlationId: randomUUID(), payload: { ...counts }
  });
  return counts;
}
