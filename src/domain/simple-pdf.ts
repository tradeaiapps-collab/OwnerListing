import { latin1, pdfText } from "./report-export";

export interface PdfBlock { text: string; size?: number; bold?: boolean; gap?: number }

const W = 595, H = 842, M = 50, BODY = 10, LEAD = 14, CHAR = 0.52;

/** A plain text PDF (A4, built-in Helvetica, text outside Latin-1 becomes "?"). Dependency-free; the same blocks always give the same bytes. */
export function buildTextPdf(blocks: readonly PdfBlock[]): Uint8Array {
  const pages: string[][] = [];
  let ops: string[] = [], y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = H - M; };
  const wrap = (text: string, size: number): string[] => {
    const max = Math.max(10, Math.floor((W - 2 * M) / (size * CHAR)));
    const out: string[] = [];
    for (const para of text.split("\n").map(latin1)) {
      let line = "";
      for (const word of para.split(" ")) {
        let w = word;
        while (w.length > max) { if (line) { out.push(line); line = ""; } out.push(w.slice(0, max)); w = w.slice(max); }
        if (!line) line = w; else if (line.length + 1 + w.length <= max) line += ` ${w}`; else { out.push(line); line = w; }
      }
      out.push(line);
    }
    return out;
  };
  newPage();
  for (const b of blocks) {
    const size = b.size ?? BODY;
    for (const l of wrap(b.text, size)) {
      if (y < M + LEAD) newPage();
      ops.push(`BT /${b.bold ? "F2" : "F1"} ${size} Tf ${M} ${y} Td (${pdfText(l)}) Tj ET`);
      y -= size === BODY ? LEAD : size + 4;
    }
    y -= b.gap ?? 0;
  }
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const body = p.join("\n");
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Array.from(out, c => c.charCodeAt(0) & 255));
}
