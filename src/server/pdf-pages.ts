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
