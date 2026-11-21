import path from "node:path";
import type { OcrPort } from "./doc-extract";

/**
 * Local text recognition for scanned PDFs and photographed documents (Tesseract compiled to WebAssembly, English). Runs on the same machine:
 * no cloud service, no account, nothing leaves the server. The language file ships in the @tesseract.js-data/eng package, so it works offline.
 * Slow on purpose-built-for-nothing hardware (a few seconds a page), so it is capped: 10 pages and 120 seconds per file. Off with OCR_ENABLED=false.
 */
export const OCR_MAX_PAGES = 10;
export const OCR_TIMEOUT_MS = 120_000;
const LANG_DIR = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");

type Worker = import("tesseract.js").Worker;
let worker: Promise<Worker> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  return (worker ??= import("tesseract.js").then(t => t.createWorker("eng", 1, { langPath: LANG_DIR, gzip: true, cacheMethod: "none" })).catch(e => { worker = undefined; throw e; }));
}

/** Pure helper for tests: pages of text joined, empty pages dropped. */
export const joinPages = (pages: readonly string[]): string => pages.map(p => p.trim()).filter(Boolean).join("\n\n");

async function recogniseImages(images: readonly Uint8Array[], deadline: number): Promise<string> {
  const w = await getWorker();
  const pages: string[] = [];
  for (const img of images) {
    if (Date.now() > deadline) break;
    pages.push((await w.recognize(Buffer.from(img))).data.text);
  }
  return joinPages(pages);
}

export function createOcrPort(env: Readonly<Record<string, string | undefined>> = process.env): OcrPort {
  return {
    configured: env["OCR_ENABLED"] !== "false",
    async recognise(bytes, contentType) {
      // One file at a time: the worker is single-threaded and a scan can be large.
      const run = queue.then(async () => {
        const deadline = Date.now() + OCR_TIMEOUT_MS;
        if (contentType === "application/pdf") {
          const { renderPdfPagesPng } = await import("./pdf-pages");
          return recogniseImages(await renderPdfPagesPng(bytes, OCR_MAX_PAGES), deadline);
        }
        return recogniseImages([bytes], deadline);
      });
      queue = run.catch(() => undefined);
      return run;
    }
  };
}
