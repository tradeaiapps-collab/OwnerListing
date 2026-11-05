import { crc32 } from "node:zlib";
import { formatMeasure, type Insights } from "./report-insights";
import { toCsv } from "./reports";
import { change, comparable, measureOf, type MeasureKey, type ReportResult } from "./saved-reports";

/**
 * Exports of one report result as CSV, Excel (.xlsx) or PDF. No libraries: the xlsx is a minimal stored zip of spreadsheet XML and the
 * PDF is one text table on A4 landscape pages. All three read the same table model, so they always agree with the screen.
 */

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const isExportFormat = (v: unknown): v is ExportFormat => EXPORT_FORMATS.includes(v as ExportFormat);

type Cell = { text: string; num?: number };
export interface Table { title: string; subtitle: string; header: string[]; rows: Cell[][]; totalRow: Cell[] }

const dollars = (c: number) => (c / 100).toFixed(2);
const pctText = (now: number, before: number) => { const c = change(now, before); return c.pct === null ? (c.abs === 0 ? "0%" : "new") : `${c.pct > 0 ? "+" : ""}${c.pct}%`; };

export function tableOf(r: ReportResult): Table {
  const cmp = r.previousTotals !== undefined;
  const header = [r.dimensionLabel];
  for (const m of r.measures) { header.push(measureOf(m).label); if (cmp) header.push(`${measureOf(m).label} (previous)`, "Change"); }
  const line = (label: string, v: ReportResult["totals"], p: ReportResult["totals"] | undefined): Cell[] => {
    const cells: Cell[] = [{ text: label }];
    for (const m of r.measures) {
      const n = v[m] ?? 0;
      cells.push({ text: formatMeasure(m, n), num: n });
      if (p) { if (!comparable(m)) { cells.push({ text: "" }, { text: "" }); continue; } const b = p[m] ?? 0; cells.push({ text: formatMeasure(m, b), num: b }, { text: pctText(n, b) }); }
    }
    return cells;
  };
  const sub = `${r.range.from} to ${r.range.to}${r.previousRange ? ` (compared with ${r.previousRange.from} to ${r.previousRange.to})` : ""}`;
  return {
    title: r.name, subtitle: sub, header,
    rows: r.rows.map(x => line(x.label, x.values, x.previous)), totalRow: line("Total", r.totals, r.previousTotals)
  };
}

export function reportToCsv(r: ReportResult): string {
  const kinds = r.measures;
  const cmp = r.previousTotals !== undefined;
  const header = [r.dimensionLabel];
  for (const m of kinds) { header.push(measureOf(m).label + (measureOf(m).kind === "cents" ? " (AUD)" : "")); if (cmp) header.push(`${measureOf(m).label} (previous)`, "Change %"); }
  const val = (m: MeasureKey, n: number) => (measureOf(m).kind === "cents" ? dollars(n) : n);
  const line = (label: string, v: ReportResult["totals"], p: ReportResult["totals"] | undefined) => {
    const out: (string | number)[] = [label];
    for (const m of kinds) {
      out.push(val(m, v[m] ?? 0));
      if (p) { if (!comparable(m)) { out.push("", ""); continue; } const c = change(v[m] ?? 0, p[m] ?? 0); out.push(val(m, p[m] ?? 0), c.pct === null ? "" : c.pct); }
    }
    return out;
  };
  return toCsv(header, [...r.rows.map(x => line(x.label, x.values, x.previous)), line("Total", r.totals, r.previousTotals)]);
}

// ---- xlsx ----

const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const col = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** Minimal zip with stored (uncompressed) entries. */
export function zipStore(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Styles: 0 plain, 1 bold header, 2 integer, 3 money (#,##0.00), 4 percent-as-number with %, 5 bold. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function reportToXlsx(r: ReportResult, insights?: Insights): Buffer {
  const cmp = r.previousTotals !== undefined;
  const cols: ({ kind: "label" } | { kind: "value"; m: MeasureKey } | { kind: "prev"; m: MeasureKey } | { kind: "chg" })[] = [{ kind: "label" }];
  for (const m of r.measures) { cols.push({ kind: "value", m }); if (cmp) cols.push({ kind: "prev", m }, { kind: "chg" }); }
  const rowsXml: string[] = [];
  let rn = 0;
  const str = (ref: string, s: string, style = 0) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
  const push = (cells: string[]) => rowsXml.push(`<row r="${++rn}">${cells.join("")}</row>`);
  push([str(`A${rn + 1}`, r.name, 5)]);
  push([str(`A${rn + 1}`, `${r.range.from} to ${r.range.to}${r.previousRange ? ` (compared with ${r.previousRange.from} to ${r.previousRange.to})` : ""}`)]);
  if (insights) { push([str(`A${rn + 1}`, `Elena: ${insights.headline}`)]); for (const p of insights.points) push([str(`A${rn + 1}`, `- ${p}`)]); }
  push([]);
  const head = [r.dimensionLabel]; for (const c of cols.slice(1)) head.push(c.kind === "value" ? measureOf(c.m).label : c.kind === "prev" ? `${measureOf(c.m).label} (previous)` : "Change %");
  push(head.map((h, i) => str(`${col(i)}${rn + 1}`, h, 1)));
  const line = (label: string, v: ReportResult["totals"], p: ReportResult["totals"] | undefined, bold: boolean) => {
    const cells: string[] = []; let prevM: MeasureKey | null = null;
    cols.forEach((c, i) => {
      const ref = `${col(i)}${rn + 1}`;
      if (c.kind === "label") { cells.push(str(ref, label, bold ? 5 : 0)); return; }
      if ((c.kind === "prev" || c.kind === "chg") && !comparable(c.kind === "prev" ? c.m : prevM!)) { cells.push(str(ref, "")); return; }
      if (c.kind === "chg") { const ch = change(v[prevM!] ?? 0, p?.[prevM!] ?? 0); cells.push(ch.pct === null ? str(ref, ch.abs === 0 ? "0" : "new") : `<c r="${ref}" s="0"><v>${ch.pct}</v></c>`); return; }
      prevM = c.m;
      const n = (c.kind === "value" ? v : p ?? {})[c.m] ?? 0, kind = measureOf(c.m).kind;
      cells.push(`<c r="${ref}" s="${kind === "cents" ? 3 : 2}"><v>${kind === "cents" ? dollars(n) : n}</v></c>`);
    });
    push(cells);
  };
  for (const x of r.rows) line(x.label, x.values, x.previous, false);
  line("Total", r.totals, r.previousTotals, true);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="${cols.length}" width="20" customWidth="1"/></cols><sheetData>${rowsXml.join("")}</sheetData></worksheet>`;
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = [
    ["[Content_Types].xml", `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", sheet]
  ] as const;
  return zipStore(files.map(([name, data]) => ({ name, data: Buffer.from(data) })));
}

// ---- pdf ----

const W = 842, H = 595, MARGIN = 36;
/** PDF text is Helvetica (WinAnsi): anything outside Latin-1 becomes "?" and brackets and backslashes are escaped. */
const pdfText = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?").replace(/([\\()])/g, "\\$1");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}.` : s);
/** Wraps on spaces; a word longer than the line is cut. */
function wrapWords(s: string, n: number): string[] {
  return wrap(s, n).flatMap(l => (l.length > n ? [l.slice(0, n)] : [l]));
}
function wrap(s: string, n: number): string[] {
  const out: string[] = []; let cur = "";
  for (const w of s.split(/\s+/)) { if ((cur + " " + w).trim().length > n) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) out.push(cur);
  return out;
}

export function reportToPdf(r: ReportResult, insights?: Insights): Buffer {
  const t = tableOf(r);
  const n = t.header.length, usable = W - 2 * MARGIN;
  const first = Math.min(190, usable * 0.28), other = (usable - first) / Math.max(1, n - 1);
  const x = (i: number) => MARGIN + (i === 0 ? 0 : first + (i - 1) * other);
  const size = n > 9 ? 7 : 8.5;
  const chars = (i: number) => Math.max(5, Math.floor(((i === 0 ? first : other) - 3) / (size * 0.56)));
  const pages: string[][] = [[]];
  let y = H - MARGIN;
  const cur = () => pages[pages.length - 1]!;
  const text = (s: string, px: number, py: number, size: number, bold = false) => cur().push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${px.toFixed(1)} ${py.toFixed(1)} Td (${pdfText(s)}) Tj ET`);
  const newPage = () => { pages.push([]); y = H - MARGIN; };
  text(t.title, MARGIN, y - 14, 16, true); y -= 32;
  text(t.subtitle, MARGIN, y, 9); y -= 16;
  if (insights) {
    text(`Elena: ${insights.headline}`, MARGIN, y, 9, true); y -= 13;
    for (const p of insights.points) for (const [k, l] of wrap(p, 150).entries()) { text(`${k === 0 ? "- " : "  "}${l}`, MARGIN, y, 9); y -= 12; }
    y -= 6;
  }
  const rule = () => cur().push(`0.6 w ${MARGIN} ${y + 11} m ${W - MARGIN} ${y + 11} l S`);
  const headRow = () => {
    const lines = t.header.map((h, i) => wrapWords(h, chars(i)).slice(0, 3));
    const height = Math.max(...lines.map(l => l.length));
    if (y < MARGIN + 20 + height * 10) newPage();
    lines.forEach((ls, i) => ls.forEach((l, k) => text(l, x(i), y - k * 10, size, true)));
    y -= height * 10 + 4;
    rule();
  };
  const row = (cells: string[], bold: boolean) => {
    if (y < MARGIN + 20) { newPage(); headRow(); }
    cells.forEach((c, i) => text(clip(c, chars(i)), x(i), y, size, bold));
    y -= 14;
  };
  headRow();
  if (t.rows.length === 0) row(["Nothing in this period."], false);
  for (const rw of t.rows) row(rw.map(c => c.text), false);
  rule();
  row(t.totalRow.map(c => c.text), true);
  pages.forEach((p, i) => p.push(`BT /F1 8 Tf ${MARGIN} 20 Td (Page ${i + 1} of ${pages.length}  -  generated ${pdfText(r.generatedAt.slice(0, 16).replace("T", " "))} UTC) Tj ET`));

  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  const kids: number[] = [];
  pages.forEach((p, i) => {
    const pageId = 5 + i * 2, contentId = 6 + i * 2, stream = p.join("\n");
    kids.push(pageId);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n"; const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out, "latin1"); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf"
};

export function exportReport(r: ReportResult, format: ExportFormat, insights?: Insights): Buffer {
  if (format === "csv") return Buffer.from(reportToCsv(r), "utf8");
  return format === "xlsx" ? reportToXlsx(r, insights) : reportToPdf(r, insights);
}

export function exportFileName(r: ReportResult, format: ExportFormat): string {
  const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";
  return `${slug}-${r.range.from}-to-${r.range.to}.${format}`;
}
