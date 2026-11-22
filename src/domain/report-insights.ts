import { change, comparable, measureOf, type MeasureKey, type ReportResult, type Values } from "./saved-reports";

/**
 * Elena's read of a report. Rule based and self-hosted (no external AI account): every sentence is built from numbers in the report,
 * so it can be checked against the table. It only uses labels already in the result, so agent names stay masked as in the table.
 */

export interface Insights { headline: string; points: string[] }

export function formatMeasure(m: MeasureKey, n: number): string {
  const kind = measureOf(m).kind;
  if (kind === "cents") return `$${(n / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (kind === "percent") return `${n}%`;
  return n.toLocaleString("en-AU");
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function reportInsights(r: ReportResult): Insights {
  const counts = r.measures.filter(m => measureOf(m).kind !== "percent");
  const primary = counts.find(comparable) ?? counts[0] ?? r.measures[0]!;
  const pLabel = lower(measureOf(primary).label);
  const total = r.totals[primary] ?? 0;
  const period = `${r.range.from} to ${r.range.to}`;
  if (r.rows.length === 0 || (counts.length > 0 && counts.every(m => (r.totals[m] ?? 0) === 0) && !r.previousTotals)) {
    return { headline: `There was no activity to report for ${period}.`, points: [] };
  }
  const points: string[] = [];
  const top = r.rows[0]!;
  const topV = top.values[primary] ?? 0;
  if (counts.length > 0 && total > 0 && topV > 0) {
    const share = Math.round((topV / total) * 100);
    points.push(`${top.label} leads on ${pLabel} with ${formatMeasure(primary, topV)}, ${share}% of the ${formatMeasure(primary, total)} in total.`);
  }
  if (r.previousTotals) {
    for (const m of counts.filter(comparable).slice(0, 2)) {
      const now = r.totals[m] ?? 0, before = r.previousTotals[m] ?? 0;
      if (now === 0 && before === 0) continue;
      const c = change(now, before);
      if (c.abs === 0) points.push(`${measureOf(m).label} are unchanged on the previous period (${formatMeasure(m, now)}).`);
      else if (c.pct === null) points.push(`${measureOf(m).label} are up from none to ${formatMeasure(m, now)} on the previous period.`);
      else points.push(`${measureOf(m).label} are ${c.abs > 0 ? "up" : "down"} ${Math.abs(c.pct)}% on the previous period (${formatMeasure(m, now)} against ${formatMeasure(m, before)}).`);
    }
    const movers = r.rows.map(x => ({ x, d: (x.values[primary] ?? 0) - (x.previous?.[primary] ?? 0) })).filter(m => m.d !== 0);
    if (movers.length > 0) {
      const big = movers.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a));
      points.push(`Biggest mover: ${big.x.label}, ${pLabel} ${big.d > 0 ? "up" : "down"} by ${formatMeasure(primary, Math.abs(big.d))}.`);
    }
  }
  const t: Values = r.totals;
  if (r.measures.includes("acceptance") && (t.offers ?? 0) > 0) {
    points.push(`Across the period ${t.acceptance ?? 0}% of offers were accepted.`);
  } else if (r.measures.includes("offers") && r.measures.includes("accepted") && (t.offers ?? 0) > 0) {
    points.push(`${formatMeasure("accepted", t.accepted ?? 0)} of ${formatMeasure("offers", t.offers ?? 0)} ${plural(t.offers ?? 0, "offer was", "offers were")} accepted.`);
  }
  const quiet = r.rows.filter(x => counts.every(m => (x.values[m] ?? 0) === 0) && counts.some(m => (x.previous?.[m] ?? 0) > 0));
  if (quiet.length > 0) points.push(`${quiet.length} ${plural(quiet.length, "group", "groups")} had activity in the previous period but none in this one: ${quiet.slice(0, 3).map(q => q.label).join(", ")}${quiet.length > 3 ? " and others" : ""}.`);
  const head = r.rows.length === 1
    ? `${top.label} is the only ${lower(r.dimensionLabel)} with activity in ${period}, with ${formatMeasure(primary, total)} ${pLabel}.`
    : `${formatMeasure(primary, total)} ${pLabel} across ${r.rows.length} ${plural(r.rows.length, lower(r.dimensionLabel), `${lower(r.dimensionLabel)} groups`)} for ${period}.`;
  return { headline: head, points: points.slice(0, 6) };
}
