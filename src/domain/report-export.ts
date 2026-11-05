/**
 * Dependency-free Excel (.xlsx) and PDF writers for a flat table. Excel cells are stored as typed numbers or inline text, never formulas,
 * so a listing title such as "=SUM(A1)" cannot run. The PDF uses the built-in Helvetica font, so text outside Latin-1 becomes "?".
 */

export type Cell = string | number;
const enc = new TextEncoder();

/* ---------- XLSX (a zip of XML parts, stored without compression) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Characters XML 1.0 cannot carry are dropped; the rest are escaped. */
const xml = (s: string) => s.replace(/[^\u0009\u000A\u000D -퟿-�]/gu, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "", n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function toXlsx(head: readonly string[], rows: readonly (readonly Cell[])[], sheetName = "Report"): Uint8Array {
  const cell = (v: Cell, r: number, c: number, bold = false) => {
    const ref = `${colName(c)}${r + 1}`, st = bold ? ' s="1"' : "";
    return typeof v === "number" && Number.isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
  };
  const all = [head, ...rows];
  const widths = head.map((h, c) => Math.min(48, Math.max(10, ...all.map(r => String(r[c] ?? "").length)) + 2));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${all.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, ri, ci, ri === 0)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report");
  const parts: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
    ["xl/worksheets/sheet1.xml", sheet]
  ];
  return zip(parts.map(([n, t]) => [n, enc.encode(t)]));
}

function zip(files: readonly [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 255, (v >> 8) & 255], u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const [name, data] of files) {
    const n = enc.encode(name), crc = crc32(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0)];
    const local = new Uint8Array([0x50, 0x4b, 3, 4, ...common, ...n]);
    chunks.push(local, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n]));
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), 0, 0]);
  return concat([...chunks, ...central, end]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- PDF (A4 landscape, Helvetica) ---------- */

const PAGE_W = 842, PAGE_H = 595, MARGIN = 40, ROW_H = 16, FONT = 9;
export const latin1 = (s: string) => Array.from(s).map(ch => (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 255 && ch !== "\u007f" ? ch : ch === "–" || ch === "—" ? "-" : ch === "‘" || ch === "’" ? "'" : ch === "“" || ch === "”" ? '"' : ch === "…" ? "..." : "?")).join("");
export const pdfText = (s: string) => latin1(s).replace(/[\\()]/g, m => `\\${m}`);
/** Helvetica averages about half the font size per character; used to fit text into a column. */
const fit = (s: string, widthPt: number, size: number) => { const max = Math.max(1, Math.floor(widthPt / (size * 0.5))); return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}~` : s; };

export function toPdf(title: string, subtitle: string, head: readonly string[], rows: readonly (readonly Cell[])[], notes: readonly string[] = []): Uint8Array {
  const usable = PAGE_W - 2 * MARGIN;
  const firstW = Math.min(usable * 0.34, usable / 2), restW = head.length > 1 ? (usable - firstW) / (head.length - 1) : 0;
  const colW = head.map((_, i) => (i === 0 ? (head.length > 1 ? firstW : usable) : restW));
  const colX = colW.map((_, i) => MARGIN + colW.slice(0, i).reduce((s, w) => s + w, 0));
  const pages: string[][] = [];
  let ops: string[] = [], y = 0;
  const newPage = (first: boolean) => {
    ops = []; pages.push(ops); y = PAGE_H - MARGIN;
    if (first) {
      ops.push(`BT /F2 16 Tf ${MARGIN} ${y} Td (${pdfText(fit(title, usable, 16))}) Tj ET`); y -= 20;
      ops.push(`BT /F1 10 Tf ${MARGIN} ${y} Td (${pdfText(fit(subtitle, usable, 10))}) Tj ET`); y -= 22;
    }
    header();
  };
  const line = (cells: readonly Cell[], bold: boolean) => {
    cells.forEach((c, i) => {
      const t = fit(String(c), colW[i]! - 8, FONT), isNum = typeof c === "number" || /^-?[\d,.]+%?$/.test(t);
      const w = t.length * FONT * 0.5, x = isNum && i > 0 ? colX[i]! + colW[i]! - 4 - w : colX[i]! + 2;
      ops.push(`BT /${bold ? "F2" : "F1"} ${FONT} Tf ${x.toFixed(1)} ${y} Td (${pdfText(t)}) Tj ET`);
    });
    ops.push(`0.85 G ${MARGIN} ${y - 4} m ${PAGE_W - MARGIN} ${y - 4} l S`);
    y -= ROW_H;
  };
  function header() { line(head, true); }
  newPage(true);
  rows.forEach((r, idx) => {
    if (y < MARGIN + ROW_H * 2) newPage(false);
    line(r.map(c => (typeof c === "number" ? String(Math.round(c * 100) / 100) : c)), idx === rows.length - 1 && String(r[0]).startsWith("Total"));
  });
  y -= 6;
  for (const n of notes) { if (y < MARGIN + ROW_H) newPage(false); ops.push(`BT /F1 8 Tf ${MARGIN} ${y} Td (${pdfText(fit(n, usable, 8))}) Tj ET`); y -= 12; }

  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages, filled below
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const body = p.join("\n");
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Array.from(out, c => c.charCodeAt(0) & 255));
}
