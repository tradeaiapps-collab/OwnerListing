/**
 * Address masking for investor project documents (pure, no I/O). Elena's auto-mask finds street addresses, unit and lot numbers,
 * plan references, PO boxes and "suburb STATE postcode" lines in a page's text and turns them into black boxes that are burned into
 * the page image, so the original text never reaches an investor's browser. The admin can add or remove boxes by hand.
 * Boxes are fractions of the page (0 to 1, origin top left), so they do not depend on the render size. Pages are numbered from 1.
 */
export interface MaskBox { page: number; x: number; y: number; w: number; h: number; source: "auto" | "manual" }
/** One run of text on a page, as fractions of the page. */
export interface TextRun { str: string; x: number; y: number; w: number; h: number }
export interface PageText { runs: TextRun[] }

export const MAX_MASK_BOXES = 2000;
export const MAX_MASK_TERMS = 20;

const STREET_TYPES = [
  "street", "st", "road", "rd", "avenue", "ave", "drive", "dr", "court", "ct", "place", "pl", "lane", "ln", "crescent", "cres", "terrace", "tce",
  "parade", "pde", "boulevard", "blvd", "highway", "hwy", "way", "close", "cl", "circuit", "cct", "esplanade", "esp", "grove", "gr", "square", "sq",
  "promenade", "mews", "walk", "rise", "row", "track", "trail", "loop", "bend", "glade", "outlook", "view", "views", "retreat", "chase", "green"
].join("|");
const STATE = "(?:QLD|NSW|VIC|SA|WA|TAS|NT|ACT)";
const UNIT = "(?:(?:unit|apt|apartment|suite|level|lvl|shop|villa|townhouse|lot)\\s*\\d+[A-Za-z]?\\s*[,/]?\\s*)?";

/** Source patterns. Matching is case-insensitive except the state codes, which are kept upper-case so "act 2000" is not an address. */
const PATTERNS: RegExp[] = [
  // 12 Smith Street, 3/45-47 Long Rd, Unit 4, 9 Old Mill Crescent
  new RegExp(`\\b${UNIT}\\d+[A-Za-z]?(?:\\s*[/-]\\s*\\d+[A-Za-z]?){0,2}\\s+(?:[A-Za-z'’.-]+\\s+){1,3}?(?:${STREET_TYPES})\\b\\.?`, "gi"),
  // Brisbane QLD 4000, Bulimba, QLD 4171
  new RegExp(`\\b(?:[A-Z][a-z'’-]+(?:\\s[A-Z][a-z'’-]+){0,2},?\\s+)?${STATE}\\s+\\d{4}\\b`, "g"),
  // Lot 12 on SP 123456, Lot 7 DP 12345
  /\blots?\s+\d+[A-Za-z]?(?:\s*[,&]\s*\d+[A-Za-z]?)*(?:\s+(?:on|in)\s+(?:plan|survey plan|registered plan|deposited plan)?\s*(?:DP|SP|RP|CP|PS|SP)?\s*\d{3,})?(?:\s*(?:DP|SP|RP|CP|PS)\s*\d{3,})?/gi,
  /\b(?:DP|SP|RP|CP|PS)\s?\d{3,}\b/g,
  /\bP\.?\s?O\.?\s?Box\s+\d+\b/gi,
  /\blot\s*\/\s*plan\s*:?\s*\d+\s*\/\s*[A-Za-z]{1,3}\s?\d+/gi
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Terms the admin adds (the exact address as the owner wrote it, a building name). Whitespace in a term matches any whitespace. */
export function cleanTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const t of terms) {
    const c = t.replace(/\s+/g, " ").trim();
    if (c.length >= 3 && c.length <= 120) seen.add(c);
    if (seen.size >= MAX_MASK_TERMS) break;
  }
  return [...seen];
}

/** Character ranges of address-like text, merged where they overlap or touch. */
export function findAddressRanges(text: string, terms: readonly string[] = []): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ start: m.index!, end: m.index! + m[0].length });
  }
  for (const t of cleanTerms(terms)) {
    const re = new RegExp(escapeRe(t).replace(/ /g, "\\s+"), "gi");
    for (const m of text.matchAll(re)) found.push({ start: m.index!, end: m.index! + m[0].length });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: { start: number; end: number }[] = [];
  for (const f of found) {
    const last = out[out.length - 1];
    // Touching ranges, or only a comma and up to three capitalised words (a suburb) between them, are one address.
    const gap = text.slice(last?.end ?? 0, f.start);
    if (last && (f.start <= last.end || (gap.length <= 40 && /^[,\s]*(?:[A-Z][a-z'’-]+[,\s]*){0,3}$/.test(gap)))) last.end = Math.max(last.end, f.end);
    else out.push({ ...f });
  }
  return out;
}

/** Helvetica glyph widths (1/1000 em) for ASCII 32 to 126. Runs are mapped to the page by these, not by equal letter widths, so a box lands on the right letters. */
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const glyph = (c: string) => { const i = c.charCodeAt(0) - 32; return i >= 0 && i < W.length ? W[i]! : 556; };
/** Cumulative widths: out[i] is the width of the first i characters. */
function cumulative(str: string): number[] {
  const out = [0];
  for (let i = 0; i < str.length; i++) out.push(out[i]! + glyph(str[i]!));
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The page's text as one string, with the character offset where each run starts. Runs on a new line are separated by a newline. */
function flatten(page: PageText): { text: string; starts: number[] } {
  let text = "";
  const starts: number[] = [];
  let prev: TextRun | undefined;
  for (const r of page.runs) {
    if (prev) {
      const sameLine = Math.abs(r.y - prev.y) < Math.max(r.h, prev.h) * 0.5;
      if (!sameLine) text += "\n";
      else if (!/\s$/.test(text) && !/^\s/.test(r.str) && r.x - (prev.x + prev.w) > r.h * 0.15) text += " ";
    }
    starts.push(text.length);
    text += r.str;
    prev = r;
  }
  return { text, starts };
}

/** Boxes for every address-like range on every page, merged per line. A little padding covers uneven letter widths. */
export function autoMaskBoxes(pages: readonly PageText[], terms: readonly string[] = []): MaskBox[] {
  const boxes: MaskBox[] = [];
  pages.forEach((page, i) => {
    const { text, starts } = flatten(page);
    for (const range of findAddressRanges(text, terms)) {
      page.runs.forEach((run, j) => {
        const s = starts[j]!, e = s + run.str.length;
        const os = Math.max(range.start, s), oe = Math.min(range.end, e);
        if (oe <= os || run.str.length === 0) return;
        const cum = cumulative(run.str), total = cum[run.str.length]!;
        const a = cum[os - s]! / total, b = cum[oe - s]! / total;
        const padX = (1.5 * run.w) / run.str.length; // about one and a half letters either side, for fonts that differ from Helvetica
        const x = clamp01(run.x + a * run.w - (os > s ? padX : 0));
        const right = clamp01(run.x + b * run.w + (oe < e ? padX : 0));
        const y = clamp01(run.y - run.h * 0.04);
        boxes.push({ page: i + 1, x, y, w: Math.max(0, right - x), h: Math.min(1 - y, run.h * 1.1), source: "auto" });
      });
    }
  });
  return mergeLineBoxes(boxes);
}

/** Boxes on the same line of the same page that touch or overlap become one. */
export function mergeLineBoxes(boxes: readonly MaskBox[]): MaskBox[] {
  const sorted = [...boxes].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const out: MaskBox[] = [];
  for (const b of sorted) {
    const l = out[out.length - 1];
    if (l && l.page === b.page && l.source === b.source && Math.abs(l.y - b.y) < 0.004 && b.x <= l.x + l.w + 0.01) {
      const right = Math.max(l.x + l.w, b.x + b.w), bottom = Math.max(l.y + l.h, b.y + b.h);
      l.w = right - l.x; l.h = bottom - l.y;
    } else out.push({ ...b });
  }
  return out;
}

export function validateBoxes(input: unknown, pageCount: number): { ok: true; boxes: MaskBox[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Boxes must be a list." };
  if (input.length > MAX_MASK_BOXES) return { ok: false, error: `At most ${MAX_MASK_BOXES} boxes per document.` };
  const boxes: MaskBox[] = [];
  for (const raw of input) {
    const b = raw as Partial<MaskBox> | null;
    if (!b || typeof b !== "object") return { ok: false, error: "A box is invalid." };
    const { page, x, y, w, h, source } = b;
    if (!Number.isInteger(page) || page! < 1 || page! > pageCount) return { ok: false, error: "A box is on a page that does not exist." };
    if (![x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n))) return { ok: false, error: "A box is invalid." };
    if (x! < 0 || y! < 0 || w! <= 0 || h! <= 0 || x! + w! > 1.0001 || y! + h! > 1.0001) return { ok: false, error: "A box is outside the page." };
    if (source !== "auto" && source !== "manual") return { ok: false, error: "A box is invalid." };
    boxes.push({ page: page!, x: x!, y: y!, w: w!, h: h!, source });
  }
  return { ok: true, boxes };
}

/** True when the centre of `needle` lies inside some box of the same page. */
export function isCovered(needle: MaskBox, boxes: readonly MaskBox[]): boolean {
  const cx = needle.x + needle.w / 2, cy = needle.y + needle.h / 2;
  return boxes.some(b => b.page === needle.page && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h);
}

/** Auto boxes that the saved boxes do not cover (the admin removed them, or the text changed since). */
export function uncoveredAuto(auto: readonly MaskBox[], saved: readonly MaskBox[]): MaskBox[] {
  return auto.filter(a => !isCovered(a, saved));
}
