import { AMENITIES, MAX_ROOMS, isAmenity, type Amenity } from "./listing-details";
import { isJurisdiction } from "./jurisdiction";
import type { Actor, Failure, Result } from "./listing-service";

/**
 * Listing templates: a saved description and standard fields to start a new listing from.
 * Never holds photos, price, title, address or suburb. Personal templates belong to their creator; a team template is
 * created or shared by a principal or manager of the agent team and is read-only for the other agents in it.
 */
export const TEMPLATE_CATEGORIES = ["house", "apartment", "villa", "vacation_rental"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = { house: "House", apartment: "Apartment", villa: "Villa", vacation_rental: "Vacation rental" };
export const FURNISHINGS = ["furnished", "unfurnished"] as const;
export type Furnishing = (typeof FURNISHINGS)[number];

const PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"] as const;
const MAX_TEMPLATES_PER_USER = 100;

export interface TemplateContent {
  description?: string; propertyType?: string; useClass?: "residential" | "commercial"; transactionType?: "sale" | "rent"; jurisdiction?: string;
  bedrooms?: number; bathrooms?: number; parking?: number; amenities?: Amenity[];
}
export interface TemplateRecord {
  id: string; createdBy: string; teamId?: string | undefined; name: string; note?: string | undefined; category: TemplateCategory; furnishing?: Furnishing | undefined; content: TemplateContent; updatedAt: string;
}
/** What the API returns: the record plus what the viewer may do with it. */
export interface TemplateView extends TemplateRecord { scope: "personal" | "team"; canEdit: boolean }

export interface TemplateDeps {
  now(): Date;
  /** The actor's active agent-team memberships (empty for owners). */
  memberships(userId: string): Promise<{ teamId: string; teamName: string; role: "principal" | "manager" | "agent" }[]>;
  count(userId: string): Promise<number>;
  insert(t: Omit<TemplateRecord, "id" | "updatedAt">): Promise<TemplateRecord>;
  get(id: string): Promise<TemplateRecord | undefined>;
  list(userId: string, teamIds: string[]): Promise<TemplateRecord[]>;
  update(id: string, t: Omit<TemplateRecord, "id" | "createdBy" | "updatedAt">): Promise<void>;
  remove(id: string): Promise<void>;
  /** Standard fields of a listing the user owns or is actively appointed to; undefined otherwise. */
  listingContent(userId: string, listingId: string): Promise<TemplateContent | undefined>;
}

const deny = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const isManager = (r: string) => r === "principal" || r === "manager";
const gate = (a: Actor): Failure | undefined => (a.userType === "owner" || a.userType === "agent" ? undefined : deny("forbidden", "Only owners and agents can use listing templates."));
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, min: number, max: number): string | undefined => { if (typeof v !== "string") return undefined; const s = v.trim(); return s.length >= min && s.length <= max ? s : undefined; };
const room = (v: unknown): number | undefined | "bad" => (v === undefined || v === null || v === "" ? undefined : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_ROOMS ? (v as number) : "bad");

/** Keeps only the fields a template may hold. Anything else (price, title, address, photos) is dropped, not an error. */
export function parseContent(input: unknown): Result<TemplateContent> {
  const b = rec(input), c: TemplateContent = {};
  if (b["description"] !== undefined && b["description"] !== null && b["description"] !== "") {
    const d = text(b["description"], 1, 5000); if (!d) return deny("invalid", "The description must be 5000 characters or fewer.");
    c.description = d;
  }
  if (b["propertyType"] != null && b["propertyType"] !== "") { if (!(PROPERTY_TYPES as readonly string[]).includes(String(b["propertyType"]))) return deny("invalid", "Choose a valid property type."); c.propertyType = String(b["propertyType"]); }
  if (b["useClass"] != null && b["useClass"] !== "") { if (b["useClass"] !== "residential" && b["useClass"] !== "commercial") return deny("invalid", "Choose residential or commercial."); c.useClass = b["useClass"]; }
  if (b["transactionType"] != null && b["transactionType"] !== "") { if (b["transactionType"] !== "sale" && b["transactionType"] !== "rent") return deny("invalid", "Choose sale or rent."); c.transactionType = b["transactionType"]; }
  if (b["jurisdiction"] != null && b["jurisdiction"] !== "") { if (!isJurisdiction(String(b["jurisdiction"]))) return deny("invalid", "Choose a valid state."); c.jurisdiction = String(b["jurisdiction"]); }
  for (const k of ["bedrooms", "bathrooms", "parking"] as const) {
    const n = room(b[k]); if (n === "bad") return deny("invalid", `${k[0]!.toUpperCase()}${k.slice(1)} must be a whole number from 0 to ${MAX_ROOMS}.`);
    if (n !== undefined) c[k] = n;
  }
  if (b["amenities"] !== undefined && b["amenities"] !== null) {
    if (!Array.isArray(b["amenities"]) || !b["amenities"].every(isAmenity)) return deny("invalid", `Amenities must come from: ${AMENITIES.join(", ")}.`);
    c.amenities = [...new Set(b["amenities"] as Amenity[])];
  }
  return { ok: true, value: c };
}

interface Header { name: string; note: string | undefined; category: TemplateCategory; furnishing: Furnishing | undefined }
function parseHeader(b: Record<string, unknown>, base?: TemplateRecord): Result<Header> {
  const name = b["name"] === undefined && base ? base.name : text(b["name"], 2, 80);
  if (!name) return deny("invalid", "Give the template a name of 2 to 80 characters.");
  const category = b["category"] === undefined && base ? base.category : b["category"];
  if (!(TEMPLATE_CATEGORIES as readonly unknown[]).includes(category)) return deny("invalid", "Choose a category: house, apartment, villa or vacation rental.");
  const f = b["furnishing"] === undefined && base ? base.furnishing : b["furnishing"] === null || b["furnishing"] === "" ? undefined : b["furnishing"];
  if (f !== undefined && !(FURNISHINGS as readonly unknown[]).includes(f)) return deny("invalid", "Choose furnished or unfurnished.");
  let note: string | undefined = base?.note;
  if (b["note"] !== undefined) { note = b["note"] === null || b["note"] === "" ? undefined : text(b["note"], 1, 300); if (b["note"] !== null && b["note"] !== "" && !note) return deny("invalid", "The note must be 300 characters or fewer."); }
  return { ok: true, value: { name, note, category: category as TemplateCategory, furnishing: f as Furnishing | undefined } };
}

const view = (t: TemplateRecord, a: Actor, roles: Map<string, string>): TemplateView =>
  t.teamId ? { ...t, scope: "team", canEdit: isManager(roles.get(t.teamId) ?? "") } : { ...t, scope: "personal", canEdit: t.createdBy === a.userId };

async function roles(d: TemplateDeps, a: Actor) {
  const ms = a.userType === "agent" ? await d.memberships(a.userId) : [];
  return { ms, map: new Map(ms.map(m => [m.teamId, m.role as string])) };
}

/** Own templates plus the templates of the agent's active team, optionally filtered by category and furnishing. */
export async function listTemplates(d: TemplateDeps, a: Actor, q: { category?: string | undefined; furnishing?: string | undefined } = {}): Promise<Result<{ templates: TemplateView[]; teams: { teamId: string; teamName: string; canManage: boolean }[] }>> {
  const f = gate(a); if (f) return f;
  const { ms, map } = await roles(d, a);
  let rows = (await d.list(a.userId, ms.map(m => m.teamId))).map(t => view(t, a, map));
  if (q.category) rows = rows.filter(t => t.category === q.category);
  if (q.furnishing) rows = rows.filter(t => t.furnishing === q.furnishing);
  return { ok: true, value: { templates: rows, teams: ms.map(m => ({ teamId: m.teamId, teamName: m.teamName, canManage: isManager(m.role) })) } };
}

async function readable(d: TemplateDeps, a: Actor, id: string): Promise<Result<{ t: TemplateRecord; map: Map<string, string> }>> {
  const f = gate(a); if (f) return f;
  const t = await d.get(id), { map } = await roles(d, a);
  // Not found for anyone who cannot see it, so that ids cannot be probed.
  if (!t || (t.teamId ? !map.has(t.teamId) : t.createdBy !== a.userId)) return deny("not_found", "Template not found.");
  return { ok: true, value: { t, map } };
}

export async function getTemplate(d: TemplateDeps, a: Actor, id: string): Promise<Result<TemplateView>> {
  const r = await readable(d, a, id); if (!r.ok) return r;
  return { ok: true, value: view(r.value.t, a, r.value.map) };
}

/** Create from a body, or from an existing listing ({ fromListingId }). { teamId } makes it a team template (principal or manager only). */
export async function createTemplate(d: TemplateDeps, a: Actor, body: unknown): Promise<Result<TemplateView>> {
  const f = gate(a); if (f) return f;
  const b = rec(body), { map } = await roles(d, a);
  const h = parseHeader(b); if (!h.ok) return h;
  let teamId: string | undefined;
  if (b["teamId"] != null && b["teamId"] !== "") {
    teamId = String(b["teamId"]);
    if (!map.has(teamId)) return deny("not_found", "Team not found.");
    if (!isManager(map.get(teamId)!)) return deny("forbidden", "Only a principal or manager can create team templates.");
  }
  let content: Result<TemplateContent>;
  if (b["fromListingId"] != null && b["fromListingId"] !== "") {
    const src = await d.listingContent(a.userId, String(b["fromListingId"]));
    if (!src) return deny("not_found", "Listing not found.");
    content = parseContent({ ...src, ...rec(b["content"]) });
  } else content = parseContent(b["content"]);
  if (!content.ok) return content;
  if ((await d.count(a.userId)) >= MAX_TEMPLATES_PER_USER) return deny("conflict", `You can keep up to ${MAX_TEMPLATES_PER_USER} templates. Delete one first.`);
  const t = await d.insert({ createdBy: a.userId, ...(teamId ? { teamId } : {}), ...h.value, content: content.value });
  return { ok: true, value: view(t, a, map) };
}

/** Edit name, note, category, furnishing and content; { teamId: "<id>" } shares with the team, { teamId: null } makes it personal again. */
export async function updateTemplate(d: TemplateDeps, a: Actor, id: string, body: unknown): Promise<Result<TemplateView>> {
  const r = await readable(d, a, id); if (!r.ok) return r;
  const { t, map } = r.value, b = rec(body);
  if (!view(t, a, map).canEdit) return deny("forbidden", t.teamId ? "Team templates are read-only unless you are a principal or manager." : "Only the creator can change this template.");
  const h = parseHeader(b, t); if (!h.ok) return h;
  const c = b["content"] === undefined ? { ok: true as const, value: t.content } : parseContent(b["content"]); if (!c.ok) return c;
  let teamId = t.teamId;
  if (b["teamId"] !== undefined) {
    if (b["teamId"] === null || b["teamId"] === "") {
      if (t.teamId && t.createdBy !== a.userId) return deny("forbidden", "Only the creator can make a team template personal.");
      teamId = undefined;
    } else {
      teamId = String(b["teamId"]);
      if (!map.has(teamId)) return deny("not_found", "Team not found.");
      if (!isManager(map.get(teamId)!)) return deny("forbidden", "Only a principal or manager can share a template with the team.");
      if (!t.teamId && t.createdBy !== a.userId) return deny("forbidden", "Only the creator can share this template.");
    }
  }
  const next = { ...(teamId ? { teamId } : {}), ...h.value, content: c.value };
  await d.update(id, next);
  return { ok: true, value: view({ ...t, ...next, ...(teamId ? {} : { teamId: undefined }), updatedAt: d.now().toISOString() }, a, map) };
}

export async function deleteTemplate(d: TemplateDeps, a: Actor, id: string): Promise<Result<{ deleted: true }>> {
  const r = await readable(d, a, id); if (!r.ok) return r;
  if (!view(r.value.t, a, r.value.map).canEdit) return deny("forbidden", r.value.t.teamId ? "Team templates can be deleted by a principal or manager only." : "Only the creator can delete this template.");
  await d.remove(id);
  return { ok: true, value: { deleted: true } };
}
