/**
 * A small, strict XML reader for property feeds (REAXML). Pure, no dependencies.
 * Safe by construction: a DOCTYPE (and so any DTD or external entity) is refused, only the five predefined entities and
 * numeric character references are expanded, and nesting depth and node count are capped. Processing instructions and
 * comments are skipped; CDATA is kept as text. Namespaces are not interpreted (prefixes stay in the name).
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export const XML_LIMITS = { maxDepth: 64, maxNodes: 500_000 } as const;

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    const v = ENTITIES[ref];
    if (v === undefined) throw new XmlError(`Unknown entity &${ref};`);
    return v;
  });
}

const NAME = /^[A-Za-z_][\w.:-]*/;

export function parseXml(input: string): XmlNode {
  const src = input.replace(/^﻿/, "");
  if (/<!DOCTYPE/i.test(src)) throw new XmlError("DOCTYPE is not allowed.");
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0, nodes = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt === -1) { top.text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlError("Unclosed comment.");
      i = end + 3; continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlError("Unclosed CDATA.");
      top.text += src.slice(lt + 9, end);
      i = end + 3; continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlError("Unclosed processing instruction.");
      i = end + 2; continue;
    }
    if (src.startsWith("<!", lt)) throw new XmlError("Declarations are not allowed.");
    const gt = findTagEnd(src, lt + 1);
    if (gt === -1) throw new XmlError("Unclosed tag.");
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (stack.length < 2 || top.name !== name) throw new XmlError(`Unexpected </${name}>.`);
      stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = NAME.exec(body);
    if (!m) throw new XmlError("Bad tag name.");
    const node: XmlNode = { name: m[0], attrs: {}, children: [], text: "" };
    readAttrs(body, m[0].length, node.attrs);
    if (++nodes > XML_LIMITS.maxNodes) throw new XmlError("Too many elements.");
    top.children.push(node);
    if (!selfClosing) {
      if (stack.length > XML_LIMITS.maxDepth) throw new XmlError("Nested too deeply.");
      stack.push(node);
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed <${stack[stack.length - 1]!.name}>.`);
  const doc = root.children[0];
  if (!doc || root.children.length !== 1) throw new XmlError("Expected one root element.");
  return doc;
}

const NAME_CHAR = /[\w.:-]/;
/**
 * Attributes of one tag, read in a single left-to-right pass (linear time: a regex here can backtrack quadratically on a
 * long run of name characters). Anything that is not name="value" or name='value' is skipped one character at a time.
 */
function readAttrs(s: string, from: number, out: Record<string, string>): void {
  let i = from;
  const n = s.length;
  while (i < n) {
    while (i < n && !/[A-Za-z_]/.test(s[i]!)) i++;
    const start = i;
    while (i < n && NAME_CHAR.test(s[i]!)) i++;
    if (i === start) break;
    const name = s.slice(start, i);
    let j = i;
    while (j < n && /\s/.test(s[j]!)) j++;
    if (s[j] !== "=") continue;
    j++;
    while (j < n && /\s/.test(s[j]!)) j++;
    const q = s[j];
    if (q !== '"' && q !== "'") { i = j; continue; }
    const end = s.indexOf(q, j + 1);
    if (end === -1) throw new XmlError("Unclosed attribute value.");
    if (!(name in out)) out[name] = decodeEntities(s.slice(j + 1, end));
    i = end + 1;
  }
}

/** The index of the '>' that ends a tag, skipping '>' inside quoted attribute values. */
function findTagEnd(s: string, from: number): number {
  let q: string | null = null;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ">") return j;
  }
  return -1;
}

/** First child with this name (case-insensitive), following a path like "address/suburb". */
export function child(node: XmlNode | undefined, path: string): XmlNode | undefined {
  let cur = node;
  for (const part of path.split("/")) {
    if (!cur) return undefined;
    const want = part.toLowerCase();
    cur = cur.children.find(c => c.name.toLowerCase() === want);
  }
  return cur;
}

/** Trimmed text of a child path, or undefined when missing or blank. */
export function textOf(node: XmlNode | undefined, path: string): string | undefined {
  const t = child(node, path)?.text.trim();
  return t ? t : undefined;
}
