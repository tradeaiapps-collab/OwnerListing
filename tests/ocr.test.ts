import * as nc from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { extractText } from "../src/server/doc-extract";
import { createOcrPort, joinPages } from "../src/server/ocr";

/** A page of large printed text as a JPEG, then wrapped in a PDF that has only that image (a scan: no text operators). */
function scanJpeg(lines: string[]): Uint8Array {
  const c = nc.createCanvas(1200, 400), ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = "#000"; ctx.font = "56px sans-serif";
  lines.forEach((l, i) => ctx.fillText(l, 40, 100 + i * 90));
  return new Uint8Array(c.toBuffer("image/jpeg", 95));
}
function scanPdf(jpg: Uint8Array): Uint8Array {
  const parts: Buffer[] = [], offsets: number[] = [];
  let len = 0;
  const add = (b: Buffer | string) => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1"); parts.push(x); len += x.length; };
  const obj = (n: number, body: Buffer | string) => { offsets[n] = len; add(`${n} 0 obj\n`); add(body); add("\nendobj\n"); };
  add("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
  obj(4, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, "latin1"), Buffer.from(jpg), Buffer.from("\nendstream")]));
  const content = "q 600 0 0 200 0 0 cm /Im0 Do Q";
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  add(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

describe("local OCR", () => {
  it("joins pages and drops empty ones", () => { expect(joinPages(["a ", "", " b"])).toBe("a\n\nb"); });

  it("can be switched off", () => { expect(createOcrPort({ OCR_ENABLED: "false" }).configured).toBe(false); expect(createOcrPort({}).configured).toBe(true); });

  it("without OCR a scanned PDF still reports needs_ocr", async () => {
    const r = await extractText(scanPdf(scanJpeg(["Weekly income 2400 dollars"])), "application/pdf");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("needs_ocr");
  });

  const jpg = scanJpeg(["Rental offer", "Weekly income 2400 dollars"]);
  it("reads a photographed page", async () => {
    const img = await extractText(jpg, "image/jpeg", createOcrPort({}));
    expect(img.ok && img.text).toMatch(/2400/);
  }, 120_000);

  it("reads a scanned PDF", async () => {
    const pdf = await extractText(scanPdf(jpg), "application/pdf", createOcrPort({}));
    expect(pdf.ok && pdf.text).toMatch(/income/i);
  }, 120_000);
});
