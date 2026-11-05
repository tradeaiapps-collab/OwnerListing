import { reasonOk, REASON_ERROR } from "./staff-admin";
import type { PropertyType } from "./listing";

/**
 * Staff bulk operations on listings: which actions exist, how their parameters are checked, and the per-listing rules that decide
 * whether a listing is changed or skipped. Pure; the database work (and the audit event for every listing) is in server/listing-bulk-db.ts.
 * Publishing never skips the publish checks: the server runs them for every listing and skips the ones that fail.
 */

export const BULK_MAX = 500;
/** Runs above this many listings are queued and finished in the background; smaller runs finish inside the request. */
export const BULK_ASYNC_ABOVE = 100;

export const BULK_ACTIONS = ["publish", "archive", "delete", "set_status", "add_tag", "set_property_type", "adjust_price", "assign_agent"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const isBulkAction = (v: unknown): v is BulkAction => typeof v === "string" && (BULK_ACTIONS as readonly string[]).includes(v);

export const BULK_LABELS: Record<BulkAction, string> = {
  publish: "Publish", archive: "Archive", delete: "Delete", set_status: "Change status", add_tag: "Add tag",
  set_property_type: "Change property type", adjust_price: "Adjust price", assign_agent: "Reassign agent"
};

export const STATUS_CHOICES = ["available", "sold", "rented"] as const;
export type StatusChoice = (typeof STATUS_CHOICES)[number];
const PROPERTY_TYPES: readonly PropertyType[] = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const RESIDENTIAL_ONLY: readonly PropertyType[] = ["house", "unit", "townhouse"];
const COMMERCIAL_ONLY: readonly PropertyType[] = ["office", "retail", "industrial", "warehouse", "hospitality"];

export const TAG_RE = /^[a-z0-9][a-z0-9 _-]{1,39}$/;
/** Highest stored price, matching the table's check constraint (cents). */
export const MAX_PRICE_CENTS = { sale: 100_000_000_000, rent: 10_000_000 } as const;

export type BulkParams =
  | { action: "publish" | "archive" | "delete" }
  | { action: "set_status"; status: StatusChoice }
  | { action: "add_tag"; tag: string }
  | { action: "set_property_type"; propertyType: PropertyType }
  | { action: "adjust_price"; mode: "percent" | "amount"; value: number }
  | { action: "assign_agent"; agentId: string };

export type ParamResult = { ok: true; params: BulkParams } | { ok: false; error: string };
const bad = (error: string): ParamResult => ({ ok: false, error });

/** Checks the action and its parameters from a request body. For assign_agent the caller resolves `agent` to an id first. */
export function parseBulkParams(action: unknown, raw: unknown): ParamResult {
  if (!isBulkAction(action)) return bad("Unknown action.");
  const p = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  switch (action) {
    case "publish": case "archive": case "delete": return { ok: true, params: { action } };
    case "set_status": {
      const status = (STATUS_CHOICES as readonly unknown[]).includes(p["status"]) ? (p["status"] as StatusChoice) : null;
      return status ? { ok: true, params: { action, status } } : bad("Choose available, sold or rented.");
    }
    case "add_tag": {
      const tag = typeof p["tag"] === "string" ? p["tag"].trim().toLowerCase() : "";
      return TAG_RE.test(tag) ? { ok: true, params: { action, tag } } : bad("A tag is 2 to 40 letters, numbers, spaces, dashes or underscores.");
    }
    case "set_property_type": {
      const t = PROPERTY_TYPES.find(x => x === p["propertyType"]);
      return t ? { ok: true, params: { action, propertyType: t } } : bad("Choose a property type.");
    }
    case "adjust_price": {
      const mode = p["mode"] === "percent" || p["mode"] === "amount" ? p["mode"] : null;
      const value = typeof p["value"] === "number" && Number.isFinite(p["value"]) ? p["value"] : null;
      if (!mode || value === null || value === 0) return bad("Enter a price change, such as 10 (%) or -50000 ($).");
      if (mode === "percent" && (value < -90 || value > 100)) return bad("A percentage change is between -90 and 100.");
      if (mode === "amount" && Math.abs(value) > 100_000_000) return bad("That dollar change is too large.");
      return { ok: true, params: { action, mode, value } };
    }
    case "assign_agent": {
      const agentId = typeof p["agentId"] === "string" ? p["agentId"] : "";
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId) ? { ok: true, params: { action, agentId } } : bad("Choose an agent.");
    }
  }
}

export type ReasonResult = { ok: true; reason: string } | { ok: false; error: string };
export const checkReason = (r: unknown): ReasonResult => (reasonOk(r) ? { ok: true, reason: r.trim() } : { ok: false, error: REASON_ERROR });

/** The sentence shown on the confirmation dialog and kept in the audit trail. */
export function describeBulk(p: BulkParams): string {
  switch (p.action) {
    case "publish": return "Publish (each listing must pass the publish checks)";
    case "archive": return "Archive (off the market, kept)";
    case "delete": return "Delete (hidden from staff lists, records kept)";
    case "set_status": return p.status === "available" ? "Mark available again (back to draft for publishing)" : `Mark ${p.status} (archived with a ${p.status} outcome)`;
    case "add_tag": return `Add the tag "${p.tag}"`;
    case "set_property_type": return `Change property type to ${p.propertyType}`;
    case "adjust_price": return p.mode === "percent" ? `Change price by ${p.value > 0 ? "+" : ""}${p.value}%` : `Change price by ${p.value > 0 ? "+" : "-"}$${Math.abs(p.value).toLocaleString("en-AU")}`;
    case "assign_agent": return "Reassign to the chosen agent";
  }
}

export interface ListingFacts {
  id: string; ownerUserId: string; status: string; transactionType: "sale" | "rent"; useClass: "residential" | "commercial";
  propertyType: string; priceCents: number | null; outcome: string | null; deleted: boolean;
  /** Offers still in play (submitted, under review, countered or accepted) and inspection bookings still on (invited or accepted). */
  activeOffers: number; activeBookings: number;
  /** The agent appointed now, if any. */
  agentUserId: string | null; hasTag: boolean;
}

export type ItemPlan = { kind: "apply"; change: string } | { kind: "skip"; reason: string };
const skip = (reason: string): ItemPlan => ({ kind: "skip", reason });
const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { maximumFractionDigits: 2 })}`;
const label = (s: string) => s.replace(/_/g, " ");

/** The new price in cents, or the reason it cannot change. Rounded to whole dollars. */
export function newPriceCents(f: Pick<ListingFacts, "priceCents" | "transactionType">, p: Extract<BulkParams, { action: "adjust_price" }>): number | string {
  if (f.priceCents === null) return "No price set.";
  const raw = p.mode === "percent" ? f.priceCents * (1 + p.value / 100) : f.priceCents + p.value * 100;
  const next = Math.round(raw / 100) * 100;
  if (next < 100) return "The new price would be below $1.";
  if (next > MAX_PRICE_CENTS[f.transactionType]) return "The new price is above the highest allowed.";
  return next;
}

/**
 * Decides one listing. `actorId` is the staff member. Rules: only live (not deleted) listings change; deleting needs no live offers or
 * bookings; staff never reassign a listing they own, or to themselves; reassigning only replaces an agent the owner already appointed.
 */
export function planBulkItem(actorId: string, f: ListingFacts, p: BulkParams): ItemPlan {
  if (f.deleted) return skip("Already deleted.");
  switch (p.action) {
    case "publish":
      return f.status === "pending_review" || f.status === "suspended" ? { kind: "apply", change: `${label(f.status)} to published` } : skip("Only a listing under review or suspended can be published.");
    case "archive":
      return f.status === "archived" ? skip("Already archived.") : { kind: "apply", change: `${label(f.status)} to archived` };
    case "delete":
      if (f.activeOffers > 0) return skip(`${f.activeOffers} open offer${f.activeOffers === 1 ? "" : "s"}.`);
      if (f.activeBookings > 0) return skip(`${f.activeBookings} inspection booking${f.activeBookings === 1 ? "" : "s"} still on.`);
      return { kind: "apply", change: "deleted" };
    case "set_status":
      if (p.status === "available") return f.outcome ? { kind: "apply", change: `${f.outcome} to draft` } : skip("Not marked sold or rented.");
      if (p.status === "sold" && f.transactionType !== "sale") return skip("Only a sale listing can be sold.");
      if (p.status === "rented" && f.transactionType !== "rent") return skip("Only a rental listing can be rented.");
      if (f.outcome) return skip(`Already ${f.outcome}.`);
      return f.status === "published" || f.status === "suspended" ? { kind: "apply", change: `${label(f.status)} to ${p.status}` } : skip("Only a published or suspended listing can be marked.");
    case "add_tag":
      return f.hasTag ? skip("Already has the tag.") : { kind: "apply", change: `tag "${p.tag}"` };
    case "set_property_type":
      if (f.propertyType === p.propertyType) return skip("Already that type.");
      if (f.useClass === "residential" && COMMERCIAL_ONLY.includes(p.propertyType)) return skip("A residential listing cannot take a commercial type.");
      if (f.useClass === "commercial" && RESIDENTIAL_ONLY.includes(p.propertyType)) return skip("A commercial listing cannot take a residential type.");
      return { kind: "apply", change: `${f.propertyType} to ${p.propertyType}` };
    case "adjust_price": {
      if (f.status === "archived") return skip("Archived listings keep their price.");
      const next = newPriceCents(f, p);
      return typeof next === "string" ? skip(next) : { kind: "apply", change: `${dollars(f.priceCents ?? 0)} to ${dollars(next)}` };
    }
    case "assign_agent":
      if (f.ownerUserId === actorId) return skip("You own this listing; ask another staff member.");
      if (p.agentId === actorId) return skip("You cannot assign a listing to yourself.");
      if (!f.agentUserId) return skip("No agent appointed yet; the owner appoints first.");
      if (f.agentUserId === p.agentId) return skip("Already with this agent.");
      if (f.ownerUserId === p.agentId) return skip("The owner cannot be their own agent.");
      return { kind: "apply", change: "agent reassigned" };
  }
}

/** One cell of a spreadsheet export: quoted, and a leading = + - @ is neutralised so a title cannot run as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: readonly unknown[]) => cells.map(csvCell).join(",");
