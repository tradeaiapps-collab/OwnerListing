import { createHash } from "node:crypto";

/**
 * Document templates: ordered clauses of plain text with {{placeholders}}, a list of fields the person generating the document fills in,
 * and a plain-English explanation per clause that the AI assistant reads out while someone signs. Pure functions only.
 * Plain text, never HTML. Nothing here is legal advice: staff publish a version only after counsel has reviewed it.
 */
export const TEMPLATE_CATEGORIES = ["contract", "disclosure", "agreement"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const isTemplateCategory = (v: unknown): v is TemplateCategory => (TEMPLATE_CATEGORIES as readonly unknown[]).includes(v);

export const FIELD_TYPES = ["text", "multiline", "date", "money"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface TemplateField { key: string; label: string; type: FieldType; required: boolean }
export interface TemplateClause { id: string; heading: string; text: string; explanation: string }
export interface TemplateContent { fields: TemplateField[]; clauses: TemplateClause[] }
export interface RenderedClause { id: string; heading: string; text: string; explanation: string }

/** Filled by the platform from the listing, never typed by the person generating the document. */
export const BUILTIN_KEYS = ["listing_title", "listing_address", "jurisdiction", "generated_date", "owner_name"] as const;
export type Builtins = Record<(typeof BUILTIN_KEYS)[number], string>;

export const LIMITS = { fields: 30, clauses: 40, heading: 120, text: 4000, explanation: 1500, label: 80, textValue: 200, multilineValue: 1000 } as const;

const KEY_RE = /^[a-z][a-z0-9_]{1,29}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const placeholders = (s: string): string[] => [...s.matchAll(PLACEHOLDER_RE)].map(m => m[1]!);

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function validateTemplateContent(raw: unknown): Validated<TemplateContent> {
  const errors: string[] = [];
  if (!isObj(raw) || !Array.isArray(raw["fields"]) || !Array.isArray(raw["clauses"])) return { ok: false, errors: ["Content needs a fields list and a clauses list."] };
  if (raw["fields"].length > LIMITS.fields) errors.push(`At most ${LIMITS.fields} fields.`);
  if (raw["clauses"].length < 1 || raw["clauses"].length > LIMITS.clauses) errors.push(`Between 1 and ${LIMITS.clauses} clauses.`);
  if (errors.length) return { ok: false, errors };

  const fields: TemplateField[] = [];
  const keys = new Set<string>(BUILTIN_KEYS);
  raw["fields"].forEach((f: unknown, i) => {
    const at = `Field ${i + 1}`;
    if (!isObj(f)) { errors.push(`${at} is not an object.`); return; }
    const key = f["key"], label = f["label"], type = f["type"];
    if (typeof key !== "string" || !KEY_RE.test(key)) { errors.push(`${at}: key must be lowercase letters, digits and underscores (2-30), starting with a letter.`); return; }
    if (keys.has(key)) errors.push(`${at}: key "${key}" is already used or reserved.`);
    keys.add(key);
    if (typeof label !== "string" || !label.trim() || label.length > LIMITS.label) errors.push(`${at}: label is required (up to ${LIMITS.label} characters).`);
    if (!(FIELD_TYPES as readonly unknown[]).includes(type)) errors.push(`${at}: type must be one of ${FIELD_TYPES.join(", ")}.`);
    fields.push({ key, label: String(label ?? "").trim(), type: type as FieldType, required: f["required"] !== false });
  });

  const clauses: TemplateClause[] = [];
  const ids = new Set<string>();
  raw["clauses"].forEach((c: unknown, i) => {
    const at = `Clause ${i + 1}`;
    if (!isObj(c)) { errors.push(`${at} is not an object.`); return; }
    const { id, heading, text, explanation } = c;
    if (typeof id !== "string" || !ID_RE.test(id)) { errors.push(`${at}: id must be lowercase letters, digits, dash or underscore (1-20).`); return; }
    if (ids.has(id)) errors.push(`${at}: id "${id}" is repeated.`);
    ids.add(id);
    if (typeof heading !== "string" || !heading.trim() || heading.length > LIMITS.heading) errors.push(`${at}: heading is required (up to ${LIMITS.heading} characters).`);
    if (typeof text !== "string" || !text.trim() || text.length > LIMITS.text) errors.push(`${at}: text is required (up to ${LIMITS.text} characters).`);
    if (typeof explanation !== "string" || !explanation.trim() || explanation.length > LIMITS.explanation) errors.push(`${at}: a plain-English explanation is required (up to ${LIMITS.explanation} characters).`);
    for (const p of placeholders(`${String(heading)} ${String(text)}`)) if (!keys.has(p)) errors.push(`${at}: {{${p}}} is not a declared field.`);
    clauses.push({ id, heading: String(heading ?? "").trim(), text: String(text ?? "").trim(), explanation: String(explanation ?? "").trim() });
  });

  return errors.length ? { ok: false, errors } : { ok: true, value: { fields, clauses } };
}

/** Reads the stored JSON back; anything that no longer validates is treated as missing rather than rendered. */
export const parseStoredContent = (raw: unknown): TemplateContent | undefined => {
  const v = validateTemplateContent(raw);
  return v.ok ? v.value : undefined;
};

const MONEY_RE = /^\d{1,10}(\.\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks the values typed for a template's fields. Unknown keys are ignored; money is dollars with optional cents; dates are YYYY-MM-DD. */
export function parseFieldValues(content: TemplateContent, input: unknown): Validated<Record<string, string>> {
  const src = isObj(input) ? input : {};
  const errors: string[] = [];
  const out: Record<string, string> = {};
  for (const f of content.fields) {
    const raw = src[f.key];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) { if (f.required) errors.push(`${f.label} is required.`); continue; }
    if (f.type === "money") {
      if (!MONEY_RE.test(v)) { errors.push(`${f.label} must be an amount in dollars, for example 650000 or 1250.50.`); continue; }
      out[f.key] = `$${Number(v).toLocaleString("en-AU", { minimumFractionDigits: v.includes(".") ? 2 : 0 })}`;
    } else if (f.type === "date") {
      if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { errors.push(`${f.label} must be a date (YYYY-MM-DD).`); continue; }
      out[f.key] = formatDate(v);
    } else {
      const max = f.type === "multiline" ? LIMITS.multilineValue : LIMITS.textValue;
      if (v.length > max) { errors.push(`${f.label} must be at most ${max} characters.`); continue; }
      out[f.key] = v;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export const formatDate = (iso: string): string => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** One pass over the text: a value is inserted as written and never searched for further placeholders. A blank optional field becomes "(not provided)". */
export function renderClauses(content: TemplateContent, values: Record<string, string>, builtins: Builtins): RenderedClause[] {
  const all: Record<string, string> = { ...values, ...builtins };
  const fill = (s: string) => s.replace(PLACEHOLDER_RE, (_m, k: string) => all[k] ?? "(not provided)");
  return content.clauses.map(c => ({ id: c.id, heading: fill(c.heading), text: fill(c.text), explanation: c.explanation }));
}

/** SHA-256 over the title and the clause headings and text, in order. Every signature records this hash. Explanations are help, not part of the agreement. */
export function documentHash(title: string, clauses: readonly RenderedClause[]): string {
  return createHash("sha256").update(JSON.stringify({ title, clauses: clauses.map(c => [c.id, c.heading, c.text]) })).digest("hex");
}

export const sameName = (a: string, b: string): boolean => {
  const n = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return n(a).length > 0 && n(a) === n(b);
};
