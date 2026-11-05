import { inflateSync } from "node:zlib";
import { cleanText } from "../domain/doc-analyst";

/**
 * Turns an uploaded file's bytes into text for Elena's document analyst. No third-party code: text, .eml and HTML are decoded
 * directly and PDFs are read from their text operators. Scanned pages (images) carry no text, so they are reported as
 * `needs_ocr` rather than guessed at; an OcrPort can be plugged in later (docs/DOC_ANALYST.md).
 */
export type ExtractResult =
  | { ok: true; text: string; pages: number; method: "text" | "email" | "html" | "pdf" }
  | { ok: false; reason: "needs_ocr" | "unsupported" | "too_large" | "empty"; message: string };

/** Optional self-hosted OCR (for example Tesseract behind an internal service). Not wired by default. */
export interface OcrPort { readonly configured: boolean; recognise(bytes: Uint8Array, contentType: string): Promise<string> }

export const MAX_EXTRACT_BYTES = 50_000_000;
const MAX_STREAM_BYTES = 20_000_000;
const MAX_STREAMS = 20_000;
const MIN_CHARS_PER_PAGE = 40;

const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

/** Decodes PDF string escapes: \n \r \t \( \) \\ and octal. */
function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, e: string) => {
    if (e === "n") return "\n";
    if (e === "r") return "\r";
    if (e === "t") return "\t";
    if (e === "b" || e === "f") return "";
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255);
    if (e.startsWith("\r") || e === "\n") return "";
    return e;
  });
}

function hexToText(hex: string): string {
  const h = hex.replace(/\s+/g, "");
  if (/^feff/i.test(h)) { let o = ""; for (let i = 4; i + 3 < h.length + 1; i += 4) { const c = parseInt(h.slice(i, i + 4), 16); if (c) o += String.fromCharCode(c); } return o; }
  let o = "";
  for (let i = 0; i + 1 < h.length; i += 2) { const c = parseInt(h.slice(i, i + 2), 16); if (c >= 32 || c === 10) o += String.fromCharCode(c); }
  return o;
}

/** Text from one content stream: the strings shown by Tj, TJ, ' and ", with line breaks at the line-move operators and ET. */
export function textFromContentStream(content: string): string {
  const out: string[] = [];
  for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
    const body = block[1] ?? "";
    const tokens = body.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]+)>\s*Tj|(T\*|[-\d.]+\s+[-\d.]+\s+T[dD])/g);
    for (const t of tokens) {
      if (t[1] !== undefined) {
        let line = "";
        for (const part of t[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>|(-?\d+(?:\.\d+)?)/g)) {
          if (part[1] !== undefined) line += unescapePdfString(part[1]);
          else if (part[2] !== undefined) line += hexToText(part[2]);
          else if (part[3] !== undefined && Number(part[3]) < -200) line += " ";
        }
        out.push(line);
      } else if (t[2] !== undefined) out.push(unescapePdfString(t[2]));
      else if (t[3] !== undefined) out.push(hexToText(t[3]));
      else if (t[4] !== undefined) out.push("\n");
    }
    out.push("\n");
  }
  return out.join("").replace(/[ \t]*\n[ \t]*/g, "\n");
}

export function extractPdfText(bytes: Uint8Array): { text: string; pages: number } {
  const raw = latin1(bytes);
  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length);
  const chunks: string[] = [];
  let n = 0;
  for (const m of raw.matchAll(/<<([^>]*(?:>(?!>)[^>]*)*)>>\s*stream\r?\n/g)) {
    if (++n > MAX_STREAMS) break;
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const dict = m[1] ?? "";
    if (/\/Subtype\s*\/(Image|Form|Type1C|CIDFontType0C|OpenType)|\/Type\s*\/(XObject|ObjStm|XRef|Metadata|FontFile)/.test(dict) && !/\/Type\s*\/Page\b/.test(dict)) continue;
    let data = Buffer.from(raw.slice(start, end), "latin1");
    if (/\/FlateDecode/.test(dict)) {
      try { data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES }); } catch { continue; }
    } else if (/\/Filter/.test(dict)) continue;
    const s = data.toString("latin1");
    if (!/BT[\s\S]*ET/.test(s)) continue;
    chunks.push(textFromContentStream(s));
  }
  return { text: chunks.join("\n"), pages };
}

const decodeEntities = (s: string): string => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d{1,6});/g, (_, d: string) => { const c = Number(d); return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : " "; });

export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " "));
}

/** Plain-text .eml: keeps From/To/Subject/Date and the text body; decodes quoted-printable and, for simple cases, base64. */
export function emlToText(eml: string): string {
  const split = eml.search(/\r?\n\r?\n/);
  const head = split < 0 ? eml : eml.slice(0, split);
  let body = split < 0 ? "" : eml.slice(split).trim();
  const headers = head.replace(/\r?\n[ \t]+/g, " ");
  const get = (h: string) => new RegExp(`^${h}:\\s*(.+)$`, "im").exec(headers)?.[1] ?? "";
  const enc = get("Content-Transfer-Encoding").trim().toLowerCase();
  const type = get("Content-Type").toLowerCase();
  const boundary = /boundary="?([^";\s]+)"?/i.exec(get("Content-Type"))?.[1];
  if (boundary && type.includes("multipart")) {
    const parts = body.split(`--${boundary}`);
    const plain = parts.find(p => /content-type:\s*text\/plain/i.test(p)) ?? parts.find(p => /content-type:\s*text\/html/i.test(p));
    if (plain) { const i = plain.search(/\r?\n\r?\n/); const ph = plain.slice(0, i); body = plain.slice(i).trim(); if (/text\/html/i.test(ph)) body = htmlToText(body); if (/quoted-printable/i.test(ph)) body = decodeQp(body); else if (/base64/i.test(ph)) body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); }
  } else if (enc === "quoted-printable") body = decodeQp(body);
  else if (enc === "base64") body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (type.includes("text/html")) body = htmlToText(body);
  const pick = (h: string) => { const v = get(h).trim(); return v ? `${h}: ${v}\n` : ""; };
  return `${pick("From")}${pick("To")}${pick("Subject")}${pick("Date")}\n${body}`;
}
const decodeQp = (s: string): string => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export async function extractText(bytes: Uint8Array, contentType: string, ocr?: OcrPort): Promise<ExtractResult> {
  if (bytes.length === 0) return { ok: false, reason: "empty", message: "The file is empty." };
  if (bytes.length > MAX_EXTRACT_BYTES) return { ok: false, reason: "too_large", message: "The file is too large to read." };
  const ct = contentType.toLowerCase();
  if (ct === "application/pdf" || latin1(bytes.subarray(0, 5)) === "%PDF-") {
    const { text, pages } = extractPdfText(bytes);
    const cleaned = cleanText(text);
    if (cleaned.length >= MIN_CHARS_PER_PAGE * Math.min(pages, 3)) return { ok: true, text: cleaned, pages, method: "pdf" };
    if (ocr?.configured) {
      try { const t = cleanText(await ocr.recognise(bytes, "application/pdf")); if (t) return { ok: true, text: t, pages, method: "pdf" }; } catch { /* fall through to needs_ocr */ }
    }
    return { ok: false, reason: "needs_ocr", message: "This PDF looks scanned or uses fonts Elena cannot read, so no text could be extracted. Upload a text version or ask for the original." };
  }
  if (ct.startsWith("image/")) {
    if (ocr?.configured) {
      try { const t = cleanText(await ocr.recognise(bytes, ct)); if (t) return { ok: true, text: t, pages: 1, method: "text" }; } catch { /* fall through */ }
    }
    return { ok: false, reason: "needs_ocr", message: "This is an image. Text recognition is not switched on yet, so Elena cannot read it." };
  }
  if (ct === "message/rfc822" || ct === "text/plain" || ct === "text/html" || ct === "text/markdown" || ct === "text/csv") {
    const s = Buffer.from(bytes).toString("utf8");
    const email = ct === "message/rfc822" || /^(from|subject|date|to):/im.test(s.slice(0, 600));
    const text = cleanText(email ? emlToText(s) : ct === "text/html" ? htmlToText(s) : s);
    return text ? { ok: true, text, pages: 1, method: email ? "email" : ct === "text/html" ? "html" : "text" } : { ok: false, reason: "empty", message: "No text found." };
  }
  return { ok: false, reason: "unsupported", message: "Elena can read PDF, plain text, HTML and email files." };
}
