import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import type { ListingDisclosure, PropertyType, UseClass } from "./listing";

/**
 * State disclosure requirements (House Listing Spec 6.1). Compliance owns the content; engineering only loads and enforces it.
 *
 * Requirements are versioned per state x sale/rent x residential/commercial. A version is drafted, then approved by a different
 * Compliance person; approving it retires the previous approved version of that combination. Publishing uses the approved version
 * only, so a combination with no approved version stays blocked (fails closed). A published listing keeps the version it passed.
 *
 * Each requirement is satisfied only when a Compliance user verifies the owner's evidence (or verifies a "not applicable" claim
 * where the item allows one). The owner can never satisfy a requirement alone.
 */

export type TransactionType = "sale" | "rent";
export const PROPERTY_TYPES: readonly PropertyType[] = [
  "house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"
];

export interface DisclosureItem {
  /** Stable key, stored on listing_disclosure. Never rename a key; retire it and add a new one. */
  key: string;
  label: string;
  /** What the owner must provide, in plain words. */
  description: string;
  /** The law or form it comes from (shown to owners and reviewers). */
  legalRef: string;
  /** Applies only to these property types. Omitted = every property type. */
  propertyTypes?: readonly PropertyType[];
  /** The owner may claim it does not apply (for example no pool); Compliance still verifies the claim. */
  notApplicableAllowed: boolean;
}

export type ConfigStatus = "draft" | "approved" | "retired";

export interface DisclosureConfigVersion {
  id: string;
  jurisdiction: Jurisdiction;
  transactionType: TransactionType;
  useClass: UseClass;
  version: number;
  items: readonly DisclosureItem[];
  status: ConfigStatus;
  note: string;
  /** Null for a version seeded by a migration. */
  createdBy: string | null;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

export type ItemState = "missing" | "submitted" | "verified" | "rejected";

export interface ChecklistItem extends DisclosureItem {
  state: ItemState;
  notApplicable: boolean;
  evidenceDocumentId: string | null;
  reviewReason: string | null;
}

/** A listing's stored disclosure row, as the checklist needs it. */
export interface DisclosureRecord extends ListingDisclosure {
  state: Exclude<ItemState, "missing">;
  notApplicable: boolean;
  evidenceDocumentId: string | null;
  reviewReason: string | null;
}

export const MAX_ITEMS = 40;
const KEY_RE = /^[a-z][a-z0-9_]{2,60}$/;

const text = (v: unknown, min: number, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : undefined;
};

/** Validates a list of requirement items from the staff editor. */
export function parseItems(input: unknown): { ok: true; value: DisclosureItem[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: "Items must be a list." };
  if (input.length > MAX_ITEMS) return { ok: false, message: `At most ${MAX_ITEMS} items.` };
  const out: DisclosureItem[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    if (typeof raw !== "object" || raw === null) return { ok: false, message: `Item ${n} is invalid.` };
    const b = raw as Record<string, unknown>;
    const key = typeof b["key"] === "string" && KEY_RE.test(b["key"]) ? b["key"] : undefined;
    if (!key) return { ok: false, message: `Item ${n}: the key must be 3 to 61 lower-case letters, digits or underscores, starting with a letter.` };
    if (seen.has(key)) return { ok: false, message: `Item ${n}: the key ${key} is used twice.` };
    seen.add(key);
    const label = text(b["label"], 3, 120);
    const description = text(b["description"], 10, 1000);
    const legalRef = text(b["legalRef"], 3, 200);
    if (!label || !description || !legalRef) {
      return { ok: false, message: `Item ${n} (${key}): label (3 to 120), description (10 to 1000) and legal reference (3 to 200 characters) are required.` };
    }
    if (typeof b["notApplicableAllowed"] !== "boolean") return { ok: false, message: `Item ${n} (${key}): say whether "not applicable" is allowed.` };
    const item: DisclosureItem = { key, label, description, legalRef, notApplicableAllowed: b["notApplicableAllowed"] };
    if (b["propertyTypes"] !== undefined && b["propertyTypes"] !== null) {
      const pts = b["propertyTypes"];
      if (!Array.isArray(pts) || pts.length === 0 || !pts.every(p => typeof p === "string" && (PROPERTY_TYPES as readonly string[]).includes(p))) {
        return { ok: false, message: `Item ${n} (${key}): property types must be a non-empty list of known types, or left out for all.` };
      }
      item.propertyTypes = [...new Set(pts as PropertyType[])];
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

export interface NewVersionInput { jurisdiction: Jurisdiction; transactionType: TransactionType; useClass: UseClass; items: DisclosureItem[]; note: string }

/** Validates a new draft version from the staff editor. An empty item list is allowed (the combination needs no disclosures). */
export function parseNewVersion(body: unknown): { ok: true; value: NewVersionInput } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Invalid input." };
  const b = body as Record<string, unknown>;
  const j = b["jurisdiction"];
  if (typeof j !== "string" || !isJurisdiction(j)) return { ok: false, message: "Unknown state." };
  const tx = b["transactionType"];
  if (tx !== "sale" && tx !== "rent") return { ok: false, message: "Choose sale or rent." };
  const use = b["useClass"];
  if (use !== "residential" && use !== "commercial") return { ok: false, message: "Choose residential or commercial." };
  const note = text(b["note"], 10, 1000);
  if (!note) return { ok: false, message: "Describe the change and its source (10 to 1000 characters)." };
  const items = parseItems(b["items"]);
  if (!items.ok) return items;
  return { ok: true, value: { jurisdiction: j, transactionType: tx, useClass: use, items: items.value, note } };
}

/** The items that apply to a property type. */
export function itemsFor(items: readonly DisclosureItem[], propertyType: PropertyType): DisclosureItem[] {
  return items.filter(i => !i.propertyTypes || i.propertyTypes.includes(propertyType));
}

/** Required keys for the publish gate. */
export function requiredKeys(items: readonly DisclosureItem[], propertyType: PropertyType): string[] {
  return itemsFor(items, propertyType).map(i => i.key);
}

/** The owner's checklist: every applicable item with where it stands. Rows for keys no longer required are ignored. */
export function buildChecklist(items: readonly DisclosureItem[], propertyType: PropertyType, jurisdiction: Jurisdiction, rows: readonly DisclosureRecord[]): ChecklistItem[] {
  const byKey = new Map(rows.filter(r => r.jurisdiction === jurisdiction).map(r => [r.key, r]));
  return itemsFor(items, propertyType).map(i => {
    const r = byKey.get(i.key);
    return {
      ...i,
      state: r?.state ?? "missing",
      notApplicable: r?.notApplicable ?? false,
      evidenceDocumentId: r?.evidenceDocumentId ?? null,
      reviewReason: r?.reviewReason ?? null
    };
  });
}

export type SubmissionInput = { kind: "evidence"; documentId: string } | { kind: "not_applicable"; note: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner submission for one item: an evidence document, or a "not applicable" claim with a short explanation. */
export function parseSubmission(body: unknown, item: DisclosureItem): { ok: true; value: SubmissionInput } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Invalid input." };
  const b = body as Record<string, unknown>;
  if (b["notApplicable"] === true) {
    if (!item.notApplicableAllowed) return { ok: false, message: `${item.label} is required for this property; it can't be marked not applicable.` };
    const note = text(b["note"], 5, 500);
    if (!note) return { ok: false, message: "Say why it does not apply (5 to 500 characters)." };
    return { ok: true, value: { kind: "not_applicable", note } };
  }
  const doc = b["evidenceDocumentId"];
  if (typeof doc !== "string" || !UUID_RE.test(doc)) return { ok: false, message: "Choose the document that shows this disclosure." };
  return { ok: true, value: { kind: "evidence", documentId: doc } };
}

/** Who may approve a draft version: not its author, and only a draft. */
export function approvalBlocker(v: Pick<DisclosureConfigVersion, "status" | "createdBy">, approverId: string): string | undefined {
  if (v.status !== "draft") return "Only a draft can be approved.";
  if (v.createdBy === approverId) return "Someone other than the author must approve this version.";
  return undefined;
}

/** Combination label for screens and messages: "QLD sale (residential)". */
export const comboLabel = (j: string, tx: string, use: string) => `${j} ${tx} (${use})`;
