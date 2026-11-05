import { DIMENSIONS } from "../domain/admin-report-builder";
import { MEASURES, PERIODS, TEMPLATES, type ReportDefinition } from "../domain/saved-reports";
import { staffCan, type StaffActor } from "../domain/staff-access";
import type { SavedReportRow } from "./saved-reports-db";

/** Choices the builder offers this staff member: platform fees only with the financial permission. */
export function catalogueFor(staff: StaffActor) {
  const fin = staffCan(staff, "report.financial");
  const measures = MEASURES.filter(m => fin || m.key !== "revenueCents");
  return {
    dimensions: DIMENSIONS, periods: PERIODS, measures,
    templates: TEMPLATES.map(t => ({ ...t, definition: { ...t.definition, measures: t.definition.measures.filter(m => fin || m !== "revenueCents") } }))
  };
}

/** A saved report is opened by its owner, or by anyone with report access when it is shared. */
export const canOpen = (row: SavedReportRow, staff: StaffActor) => row.ownerUserId === staff.id || row.shared;

/** Someone running another person's shared report gets it without platform fees unless they hold the financial permission. */
export function forViewer(def: ReportDefinition, staff: StaffActor): ReportDefinition | null {
  const measures = staffCan(staff, "report.financial") ? def.measures : def.measures.filter(m => m !== "revenueCents");
  return measures.length > 0 ? { ...def, measures } : null;
}

/** Definition from the query string of a download link (?name&dimension&measures=a,b&period&from&to&compare=1). */
export function definitionFromParams(p: URLSearchParams): Record<string, unknown> {
  return {
    name: p.get("name") ?? "Report", dimension: p.get("dimension"), measures: (p.get("measures") ?? "").split(",").filter(Boolean),
    period: p.get("period"), from: p.get("from") ?? undefined, to: p.get("to") ?? undefined, compare: p.get("compare") === "1"
  };
}
