import path from "node:path";
import * as nc from "@napi-rs/canvas";
import type { PageRenderer } from "../domain/project-document-masking";
import type { MaskBox, PageText } from "../domain/doc-masking";

/**
 * Renders PDF and image pages to flat images on the server (pdf.js on a canvas) so the browser never receives the original file.
 * Masks are drawn into the pixels. Output is WebP; nothing in it can be selected or copied as text.
 */
const MAX_PAGES = 300;
const PAGE_WIDTH_PX = 1100;
const FONT_DIR = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | undefined;
function loadPdfJs(): Promise<PdfJs> {
  const g = globalThis as Record<string, unknown>;
  g["Path2D"] ??= nc.Path2D; g["DOMMatrix"] ??= nc.DOMMatrix; g["ImageData"] ??= nc.ImageData;
  return (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
}

async function openPdf(bytes: Uint8Array) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({
    data: bytes.slice(), isEvalSupported: false, enableXfa: false, useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: FONT_DIR, verbosity: 0
  }).promise;
  if (doc.numPages > MAX_PAGES) { await doc.destroy(); throw new Error("too many pages"); }
  return { lib, doc };
}

const isPdf = (mime: string) => mime === "application/pdf";

function drawMasks(ctx: nc.SKRSContext2D, w: number, h: number, boxes: readonly MaskBox[]) {
  ctx.fillStyle = "#000";
  for (const b of boxes) ctx.fillRect(Math.floor(b.x * w), Math.floor(b.y * h), Math.ceil(b.w * w) + 1, Math.ceil(b.h * h) + 1);
}

/** Faint repeated diagonal text, so a screenshot can be traced to the person who viewed it. */
function drawWatermark(ctx: nc.SKRSContext2D, w: number, h: number, text: string) {
  ctx.save();
  ctx.globalAlpha = 0.13; ctx.fillStyle = "#1f2a44"; ctx.font = `${Math.round(w / 38)}px sans-serif`;
  ctx.rotate(-Math.PI / 6);
  const stepX = ctx.measureText(text).width + w / 8, stepY = w / 7;
  for (let y = -h; y < h * 1.6; y += stepY) for (let x = -w; x < w * 1.6; x += stepX) ctx.fillText(text, x, y);
  ctx.restore();
}

/** Plain text of a PDF (first 40 pages), for Elena reading inspection reports. Empty for scans. Never throws. */
export async function extractPdfText(bytes: Uint8Array, maxChars = 40_000): Promise<string> {
  let opened: Awaited<ReturnType<typeof openPdf>> | undefined;
  try {
    opened = await openPdf(bytes);
    let out = "";
    for (let n = 1; n <= Math.min(opened.doc.numPages, 40) && out.length < maxChars; n++) {
      const page = await opened.doc.getPage(n);
      const content = await page.getTextContent();
      out += content.items.map(it => ("str" in it ? it.str : "")).join(" ") + "\n";
      page.cleanup();
    }
    return out.slice(0, maxChars);
  } catch { return ""; } finally { await opened?.doc.destroy().catch(() => undefined); }
}

/** Plain text of each page (first 60 pages, 12,000 characters each) for Elena quoting investor project documents. Empty list for scans. Never throws. */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  let opened: Awaited<ReturnType<typeof openPdf>> | undefined;
  try {
    opened = await openPdf(bytes);
    const out: string[] = [];
    for (let n = 1; n <= Math.min(opened.doc.numPages, 60); n++) {
      const page = await opened.doc.getPage(n);
      const content = await page.getTextContent();
      out.push(content.items.map(it => ("str" in it ? it.str : "")).join(" ").slice(0, 12_000));
      page.cleanup();
    }
    return out;
  } catch { return []; } finally { await opened?.doc.destroy().catch(() => undefined); }
}

/** Picture of one embedded image as RGBA, or undefined for a layout this reader does not handle. */
function toRgba(img: { width: number; height: number; kind?: number; data?: Uint8ClampedArray | Uint8Array }): Uint8ClampedArray | undefined {
  const { width: w, height: h, data } = img;
  if (!data || w < 1 || h < 1 || w * h > 40_000_000) return undefined;
  const out = new Uint8ClampedArray(w * h * 4);
  if (img.kind === 3 && data.length >= w * h * 4) { out.set(data.subarray(0, w * h * 4)); return out; }
  if (img.kind === 2 && data.length >= w * h * 3) { for (let i = 0, j = 0; i < w * h; i++, j += 3) { out[i * 4] = data[j]!; out[i * 4 + 1] = data[j + 1]!; out[i * 4 + 2] = data[j + 2]!; out[i * 4 + 3] = 255; } return out; }
  if (img.kind === 1) {
    const rowBytes = (w + 7) >> 3;
    if (data.length < rowBytes * h) return undefined;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (data[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0; const o = (y * w + x) * 4; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; }
    return out;
  }
  return undefined;
}

/**
 * The picture on each of the first `maxPages` pages of a scanned PDF as PNG (the largest embedded image per page, about 1600 px wide), for text
 * recognition. The images are read from the PDF and drawn directly: pdf.js painting images onto the server canvas crashes the process on some
 * machines, so this path never asks it to. Pages with no picture (real text pages) are skipped. Throws on an unreadable file.
 */
export async function renderPdfPagesPng(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]> {
  const { lib, doc } = await openPdf(bytes);
  try {
    const out: Uint8Array[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      let best: { width: number; height: number; rgba: Uint8ClampedArray } | undefined;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== lib.OPS.paintImageXObject) continue;
        const name = (ops.argsArray[i] as unknown[])[0] as string;
        const img = await new Promise<{ width: number; height: number; kind?: number; data?: Uint8ClampedArray } | undefined>(res => page.objs.get(name, res));
        if (!img || (best && img.width * img.height <= best.width * best.height)) continue;
        const rgba = toRgba(img);
        if (rgba) best = { width: img.width, height: img.height, rgba };
      }
      page.cleanup();
      if (!best) continue;
      const src = nc.createCanvas(best.width, best.height);
      src.getContext("2d").putImageData(new nc.ImageData(best.rgba, best.width, best.height), 0, 0);
      const scale = Math.min(1, 1600 / best.width);
      const canvas = nc.createCanvas(Math.max(1, Math.round(best.width * scale)), Math.max(1, Math.round(best.height * scale)));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      out.push(new Uint8Array(canvas.toBuffer("image/png")));
    }
    return out;
  } finally { await doc.destroy(); }
}

export function createPageRenderer(): PageRenderer {
  return {
    async analyse(bytes, mime) {
      if (!isPdf(mime)) return { pageCount: 1, pages: [{ runs: [] }], textFound: false };
      const { lib, doc } = await openPdf(bytes);
      try {
        const pages: PageText[] = [];
        let textFound = false;
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const runs: PageText["runs"] = [];
          for (const it of content.items) {
            if (!("str" in it) || it.str.length === 0) continue;
            const t = lib.Util.transform(vp.transform, it.transform);
            const h = Math.hypot(t[2]!, t[3]!), w = it.width * vp.scale;
            runs.push({ str: it.str, x: t[4]! / vp.width, y: (t[5]! - h * 0.85) / vp.height, w: w / vp.width, h: (h * 1.05) / vp.height });
            if (it.str.trim()) textFound = true;
          }
          pages.push({ runs });
          page.cleanup();
        }
        return { pageCount: doc.numPages, pages, textFound };
      } finally { await doc.destroy(); }
    },

    async render(bytes, mime, pageNo, opts) {
      let canvas: nc.Canvas, pageCount = 1;
      if (isPdf(mime)) {
        const { doc } = await openPdf(bytes);
        try {
          pageCount = doc.numPages;
          if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > pageCount) throw new Error("no such page");
          const page = await doc.getPage(pageNo);
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: PAGE_WIDTH_PX / base.width });
          canvas = nc.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
          page.cleanup();
        } finally { await doc.destroy(); }
      } else {
        if (pageNo !== 1) throw new Error("no such page");
        const img = await nc.loadImage(Buffer.from(bytes));
        const scale = Math.min(1, PAGE_WIDTH_PX / img.width);
        canvas = nc.createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      const ctx = canvas.getContext("2d");
      drawMasks(ctx, canvas.width, canvas.height, opts.boxes.filter(b => b.page === pageNo));
      if (opts.watermark) drawWatermark(ctx, canvas.width, canvas.height, opts.watermark);
      return { image: new Uint8Array(canvas.toBuffer("image/webp", 80)), contentType: "image/webp", pageCount };
    }
  };
}
