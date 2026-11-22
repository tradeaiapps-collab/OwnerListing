import { randomUUID } from "node:crypto";
import {
  DEFAULT_CRITERIA, RENTAL_LIMITS, REPAIR_LABELS, URGENT_KINDS, checkRentalOutbound, draftRental, emergencyTradeFor, evaluate, needsTenantConsent, parseApplication, parseCriteria,
  parseRepair, parseSlots, pickOffers, rankApplications, rentalRateLimited, repairDue, triage, MISSING_PROMPT, type ApplicationFields, type Criteria, type CriterionKey,
  type Evaluation, type RentalMessageKind, type RentalVars, type RepairCategory, type RepairContext, type RepairStatus, type RepairStep, type Urgency
} from "../domain/elena-rentals";
import { formatAppointment } from "../domain/elena-scheduling";
import type { Failure, Result } from "../domain/listing-service";
import { isJurisdiction, type Jurisdiction } from "../domain/jurisdiction";
import { bookContractor, suggestFor } from "../domain/job-board";
import { parseTenantNotice } from "../domain/contractor-ops";
import { sniffMime } from "../domain/file-sniff";
import { stripImageMetadata } from "../domain/image-meta";
import type { MalwareScanPort } from "../adapters/malware-scan";
import { assignmentIds, createPgAssignmentRepository } from "./assignment-db";
import { createPgMarketStore } from "./contractor-market-db";
import { getJobContext } from "./contractor-ops-db";
import { sendTenantNotice } from "./contractor-ops-notify";
import { ELIGIBLE_SQL } from "./elena-jobs-db";
import { submitUrgentRequest } from "./emergency-dispatch";
import { makeJobNotify } from "./job-notify";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";
import { withinRates } from "./rate-guard";

// Constant SQL text; user input only travels as bound parameters. Every owner action checks owner_user_id and every tenant or applicant action
// checks their own user id inside the statement. Nothing here deletes a person's record; messages are insert-only.

type Env = Readonly<Record<string, string | undefined>>;
const str = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const optIso = (v: unknown) => (v === null || v === undefined ? undefined : iso(v));
const optStr = (v: unknown) => (v === null || v === undefined ? undefined : str(v));
const dateStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const notFound = fail("not_found", "Not found.");
const first = (name: string) => name.trim().split(/\s+/)[0] || "there";

// ---- Sending --------------------------------------------------------------------------------------------------------------------

export interface RentalSender { send(userId: string, kind: RentalMessageKind, title: string, body: string, link: string): Promise<boolean> }

/** Real delivery on the person's own notification settings. Emergencies go as the urgent kind (text and push where they allow it). */
export function createRentalSender(db: Queryable, env: Env = process.env): RentalSender {
  return {
    async send(userId, kind, title, body, link) {
      const r = await notifyUser(db, userId, URGENT_KINDS.has(kind) ? "rental_urgent" : "rental_update", { title, text: body, link }, env);
      return r.inApp || r.email === "sent" || r.sms === "sent";
    }
  };
}

const LOG_SQL = "INSERT INTO rental_message (id, listing_id, subject_type, subject_id, to_user_id, kind, body, status, reason) VALUES ($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::text,$7::text,$8::text,$9::text)";
const SENT_SQL = "SELECT created_at FROM rental_message WHERE to_user_id = $1::uuid AND subject_id = $2::uuid AND status = 'sent' AND created_at >= $3::timestamptz";
const NAME_SQL = "SELECT display_name FROM app_user WHERE id = $1::uuid";

interface Say { listingId: string; subjectType: "application" | "viewing" | "repair"; subjectId: string; to: string; kind: RentalMessageKind; vars: Omit<RentalVars, "name"> & { name?: string }; link: string; now: string; address: string }
/** One message: fixed wording, content-checked, rate-limited per person per subject, logged. Returns how it went. A blocked message is never sent. */
/** Until the applicant is shortlisted, approved or has a booked viewing, they and the owner see the suburb only: the street address and the applicant's identity stay private. */
const IDENTITY_STATUSES: readonly string[] = ["shortlisted", "approved"];
const placeLabel = (suburb: unknown, postcode: unknown): string => [suburb, postcode].map(x => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join(" ") || "this rental";
const REVEAL_SQL = "SELECT a.status, a.applicant_user_id, l.suburb, l.postcode, EXISTS (SELECT 1 FROM rental_viewing v WHERE v.application_id = a.id AND v.status IN ('booked','attended','no_show')) AS booked FROM rental_application a JOIN property_listing l ON l.id = a.listing_id WHERE a.id = $1::uuid";
/** The address an applicant may be told: the street address only once shortlisted, approved or with a booked viewing; the suburb before that. */
export async function addressForApplicant(db: Queryable, appId: string, applicantId: string, fullAddress: string): Promise<string> {
  if (!UUID.test(appId)) return fullAddress;
  const r = (await db.query(REVEAL_SQL, [appId])).rows[0];
  if (!r || str(r["applicant_user_id"]) !== applicantId) return fullAddress;
  return IDENTITY_STATUSES.includes(str(r["status"])) || r["booked"] === true ? fullAddress : placeLabel(r["suburb"], r["postcode"]);
}
/** What the owner sees for an applicant: a first name only once shortlisted or approved, otherwise "Applicant N". */
async function ownerLabel(db: Queryable, appId: string): Promise<string> {
  const r = (await db.query(APP_BY_ID_SQL, [appId])).rows[0];
  if (!r) return "An applicant";
  return IDENTITY_STATUSES.includes(str(r["status"])) ? first(str(r["display_name"])) : `Applicant ${Number(r["applicant_no"])}`;
}

async function say(db: Queryable, sender: RentalSender, m: Say): Promise<"sent" | "blocked" | "rate_limited" | "failed"> {
  const name = first(str((await db.query(NAME_SQL, [m.to])).rows[0]?.["display_name"] ?? ""));
  const address = m.subjectType === "repair" ? m.address : await addressForApplicant(db, m.subjectId, m.to, m.address);
  const draft = draftRental(m.kind, { ...m.vars, address, name: m.vars.name ?? name });
  const log = (status: string, reason?: string) => db.query(LOG_SQL, [randomUUID(), m.listingId, m.subjectType, m.subjectId, m.to, m.kind, draft.body.slice(0, 2000), status, reason ?? null]);
  const check = checkRentalOutbound(draft);
  if (!check.ok) { await log("blocked", check.reason); return "blocked"; }
  const since = new Date(new Date(m.now).getTime() - 24 * 3600_000).toISOString();
  if (rentalRateLimited((await db.query(SENT_SQL, [m.to, m.subjectId, since])).rows.map(r => iso(r["created_at"])), m.now)) { await log("rate_limited", "Daily message limit for this person on this item."); return "rate_limited"; }
  const ok = await sender.send(m.to, m.kind, draft.title, draft.body, m.link).catch(() => false);
  await log(ok ? "sent" : "failed", ok ? undefined : "Delivery failed.");
  return ok ? "sent" : "failed";
}

async function audit(db: Queryable, actorId: string, aggregate: string, id: string, event: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    "INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) VALUES ($1::uuid, now(), $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::jsonb)",
    [randomUUID(), actorId === "elena" ? "service" : "user", actorId, aggregate, id, event, randomUUID(), JSON.stringify(payload)]);
}

// ---- Listings and settings ------------------------------------------------------------------------------------------------------

export interface RentListing { id: string; ownerId: string; address: string; suburb?: string; postcode?: string; jurisdiction: Jurisdiction; weeklyRentCents?: number; status: string }
export const RENT_LISTING_SQL = "SELECT id, owner_user_id, address_text, suburb, postcode, jurisdiction, price_cents, status FROM property_listing WHERE id = $1::uuid AND transaction_type = 'rent'";
const toListing = (r: Record<string, unknown>): RentListing => ({
  id: str(r["id"]), ownerId: str(r["owner_user_id"]), address: str(r["address_text"]), ...(r["suburb"] ? { suburb: str(r["suburb"]) } : {}), ...(r["postcode"] ? { postcode: str(r["postcode"]) } : {}),
  jurisdiction: (isJurisdiction(str(r["jurisdiction"]).trim()) ? str(r["jurisdiction"]).trim() : "NSW") as Jurisdiction,
  ...(r["price_cents"] === null || r["price_cents"] === undefined ? {} : { weeklyRentCents: Number(r["price_cents"]) }), status: str(r["status"])
});
export async function rentListing(db: Queryable, listingId: string): Promise<RentListing | undefined> {
  if (!UUID.test(listingId)) return undefined;
  const r = (await db.query(RENT_LISTING_SQL, [listingId])).rows[0];
  return r ? toListing(r) : undefined;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function ownRent(db: Queryable, ownerId: string, listingId: string): Promise<RentListing | undefined> {
  const l = await rentListing(db, listingId);
  return l && l.ownerId === ownerId ? l : undefined;
}

export interface RentalSettings extends Criteria { elenaOn: boolean; autoRepairOffers: boolean; autoEmergency: boolean }
export const DEFAULT_SETTINGS: RentalSettings = { ...DEFAULT_CRITERIA, elenaOn: false, autoRepairOffers: false, autoEmergency: false };
export const GET_SETTINGS_SQL = "SELECT elena_on, max_rent_pct, min_history_months, min_references, move_in_from, move_in_to, auto_repair_offers, auto_emergency FROM rental_settings WHERE listing_id = $1::uuid";
/** Params: 1 listing, 2 owner (must own a rent listing), 3 elena, 4 max pct, 5 history, 6 references, 7 from, 8 to, 9 auto repair, 10 auto emergency. Zero rows when the caller does not own it. */
export const SAVE_SETTINGS_SQL =
  "INSERT INTO rental_settings (listing_id, elena_on, max_rent_pct, min_history_months, min_references, move_in_from, move_in_to, auto_repair_offers, auto_emergency, updated_by) " +
  "SELECT l.id, $3::boolean, $4::integer, $5::integer, $6::integer, $7::date, $8::date, $9::boolean AND $3::boolean, $10::boolean AND $3::boolean, $2::uuid FROM property_listing l " +
  "WHERE l.id = $1::uuid AND l.owner_user_id = $2::uuid AND l.transaction_type = 'rent' " +
  "ON CONFLICT (listing_id) DO UPDATE SET elena_on = EXCLUDED.elena_on, max_rent_pct = EXCLUDED.max_rent_pct, min_history_months = EXCLUDED.min_history_months, min_references = EXCLUDED.min_references, " +
  "move_in_from = EXCLUDED.move_in_from, move_in_to = EXCLUDED.move_in_to, auto_repair_offers = EXCLUDED.auto_repair_offers, auto_emergency = EXCLUDED.auto_emergency, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING listing_id";

export async function getSettings(db: Queryable, listingId: string): Promise<RentalSettings> {
  const r = (await db.query(GET_SETTINGS_SQL, [listingId])).rows[0];
  if (!r) return { ...DEFAULT_SETTINGS };
  return {
    elenaOn: r["elena_on"] === true, maxRentPct: Number(r["max_rent_pct"]), minHistoryMonths: Number(r["min_history_months"]), minReferences: Number(r["min_references"]),
    ...(r["move_in_from"] ? { moveInFrom: dateStr(r["move_in_from"]) } : {}), ...(r["move_in_to"] ? { moveInTo: dateStr(r["move_in_to"]) } : {}),
    autoRepairOffers: r["auto_repair_offers"] === true, autoEmergency: r["auto_emergency"] === true
  };
}

export async function saveSettings(db: Queryable, ownerId: string, listingId: string, input: unknown): Promise<Result<RentalSettings>> {
  const c = parseCriteria(input);
  if (!c.ok) return c;
  const o = (input ?? {}) as Record<string, unknown>;
  const b = (k: string) => o[k] === true;
  const rows = (await db.query(SAVE_SETTINGS_SQL, [listingId, ownerId, b("elenaOn"), c.value.maxRentPct, c.value.minHistoryMonths, c.value.minReferences, c.value.moveInFrom ?? null, c.value.moveInTo ?? null, b("autoRepairOffers"), b("autoEmergency")])).rows;
  if (rows.length !== 1) return notFound;
  await audit(db, ownerId, "rental_settings", listingId, "rental_settings_saved", { elenaOn: b("elenaOn"), autoRepairOffers: b("autoRepairOffers") && b("elenaOn"), autoEmergency: b("autoEmergency") && b("elenaOn") });
  return { ok: true, value: await getSettings(db, listingId) };
}

// ---- Applications ---------------------------------------------------------------------------------------------------------------

export interface ApplicationRow extends ApplicationFields { id: string; listingId: string; applicantId: string; applicantName: string; applicantNo: number; identityHidden?: boolean; status: string; note?: string; noteWithheld: boolean; infoRequests: number; createdAt: string; updatedAt: string }
const APP_COLS = "a.id, a.listing_id, a.applicant_user_id, u.display_name, a.status, a.weekly_income_cents, a.rental_history_months, a.references_count, a.move_in_date, a.note, a.note_withheld, a.info_requests, a.created_at, a.updated_at, (SELECT count(*) FROM rental_application b WHERE b.listing_id = a.listing_id AND (b.created_at, b.id) <= (a.created_at, a.id))::int AS applicant_no";
const APP_FROM = " FROM rental_application a JOIN app_user u ON u.id = a.applicant_user_id";
const toApp = (r: Record<string, unknown>): ApplicationRow => ({
  id: str(r["id"]), listingId: str(r["listing_id"]), applicantId: str(r["applicant_user_id"]), applicantName: str(r["display_name"]), applicantNo: Number(r["applicant_no"]), status: str(r["status"]),
  ...(r["weekly_income_cents"] === null ? {} : { weeklyIncomeCents: Number(r["weekly_income_cents"]) }),
  ...(r["rental_history_months"] === null ? {} : { rentalHistoryMonths: Number(r["rental_history_months"]) }),
  ...(r["references_count"] === null ? {} : { referencesCount: Number(r["references_count"]) }),
  ...(r["move_in_date"] ? { moveInDate: dateStr(r["move_in_date"]) } : {}), ...(r["note"] && r["note_withheld"] !== true ? { note: str(r["note"]) } : {}),
  noteWithheld: r["note_withheld"] === true, infoRequests: Number(r["info_requests"]), createdAt: iso(r["created_at"]), updatedAt: iso(r["updated_at"])
});
export const APPS_FOR_LISTING_SQL = `SELECT ${APP_COLS}${APP_FROM} WHERE a.listing_id = $1::uuid AND a.status <> 'withdrawn' ORDER BY a.created_at`;
export const APP_BY_ID_SQL = `SELECT ${APP_COLS}${APP_FROM} WHERE a.id = $1::uuid`;

/**
 * Params: 1 listing, 2 applicant, 3 income, 4 history, 5 references, 6 move-in, 7 note, 8 withheld. Updating resets "info requested" to "submitted"
 * but never undoes an owner decision. Returns the row and whether it was an insert.
 */
export const UPSERT_APP_SQL =
  "INSERT INTO rental_application (listing_id, applicant_user_id, weekly_income_cents, rental_history_months, references_count, move_in_date, note, note_withheld) " +
  "VALUES ($1::uuid,$2::uuid,$3::integer,$4::integer,$5::integer,$6::date,$7::text,$8::boolean) " +
  "ON CONFLICT (listing_id, applicant_user_id) DO UPDATE SET weekly_income_cents = EXCLUDED.weekly_income_cents, rental_history_months = EXCLUDED.rental_history_months, " +
  "references_count = EXCLUDED.references_count, move_in_date = EXCLUDED.move_in_date, note = EXCLUDED.note, note_withheld = EXCLUDED.note_withheld, updated_at = now(), " +
  "status = CASE WHEN rental_application.status IN ('info_requested','withdrawn') THEN 'submitted' ELSE rental_application.status END " +
  "RETURNING id, (xmax = 0) AS inserted, status";

export interface ApplyOutcome { id: string; evaluation: Evaluation; missing: CriterionKey[]; noteWithheld: boolean; offers: SlotView[] }

export async function submitApplication(db: Queryable, sender: RentalSender, userId: string, listingId: string, input: unknown, now: string): Promise<Result<ApplyOutcome>> {
  const l = await rentListing(db, listingId);
  if (!l || l.status !== "published") return notFound;
  if (l.ownerId === userId) return fail("forbidden", "You cannot apply to your own listing.");
  const p = parseApplication(input, now);
  if (!p.ok) return p;
  if (!(await withinRates(db, "rental-apply", [userId], { windowMs: 24 * 3600_000, limit: RENTAL_LIMITS.applicationsPerDay }, new Date(now)))) return fail("rate_limited", "You have sent a lot of applications today. Try again tomorrow.");
  const v = p.value;
  const up = (await db.query(UPSERT_APP_SQL, [listingId, userId, v.weeklyIncomeCents ?? null, v.rentalHistoryMonths ?? null, v.referencesCount ?? null, v.moveInDate ?? null, v.note ?? null, v.noteWithheld])).rows[0]!;
  const id = str(up["id"]);
  const settings = await getSettings(db, listingId);
  const evaluation = evaluate(v, settings, l.weeklyRentCents);
  await audit(db, userId, "rental_application", id, up["inserted"] === true ? "rental_application_submitted" : "rental_application_updated", { listingId, noteWithheld: v.noteWithheld });
  const link = "/rentals";
  const offers = pickOffers(await slotsFor(db, listingId), now);
  const missingText = evaluation.missing.map(k => MISSING_PROMPT[k]).join("; ");
  const listText = offers.map(o => formatAppointment(o.startsAt, l.jurisdiction)).join("; ");
  const base = { listingId, subjectType: "application" as const, subjectId: id, now, address: l.address };
  if (up["inserted"] === true) {
    await say(db, sender, { ...base, to: userId, kind: "application_received", vars: { address: l.address, ...(missingText ? { missing: missingText } : {}), ...(settings.elenaOn && listText ? { list: listText } : {}) }, link });
    await say(db, sender, { ...base, to: l.ownerId, kind: "application_owner", vars: { address: l.address, headline: evaluation.headline }, link: `/listings/${listingId}/rentals` });
  }
  if (settings.elenaOn && evaluation.missing.length > 0) await askForInfo(db, sender, id, userId, l, evaluation.missing, now);
  return { ok: true, value: { id, evaluation, missing: evaluation.missing, noteWithheld: v.noteWithheld, offers } };
}

const INFO_CLAIM_SQL =
  "UPDATE rental_application SET info_requests = info_requests + 1, last_info_request_at = $2::timestamptz, status = CASE WHEN status = 'submitted' THEN 'info_requested' ELSE status END " +
  `WHERE id = $1::uuid AND info_requests < ${RENTAL_LIMITS.infoRequestsMax} AND status NOT IN ('declined','withdrawn','approved') AND (last_info_request_at IS NULL OR last_info_request_at <= $2::timestamptz - interval '${RENTAL_LIMITS.infoRequestGapMs / 1000} seconds') RETURNING id`;
/** Elena asks the applicant for what is missing: at most twice, two days apart, never after a decision. */
async function askForInfo(db: Queryable, sender: RentalSender, appId: string, applicantId: string, l: RentListing, missing: CriterionKey[], now: string): Promise<boolean> {
  if ((await db.query(INFO_CLAIM_SQL, [appId, now])).rows.length === 0) return false;
  await say(db, sender, { listingId: l.id, subjectType: "application", subjectId: appId, to: applicantId, kind: "info_request", vars: { address: l.address, missing: missing.map(k => MISSING_PROMPT[k]).join("; ") }, link: "/rentals", now, address: l.address });
  return true;
}

export const WITHDRAW_SQL = "UPDATE rental_application SET status = 'withdrawn', updated_at = now() WHERE id = $1::uuid AND applicant_user_id = $2::uuid AND status NOT IN ('approved','declined','withdrawn') RETURNING id";
export const CANCEL_APP_VIEWINGS_SQL = "UPDATE rental_viewing SET status = 'cancelled', updated_at = now() WHERE application_id = $1::uuid AND status = 'booked' RETURNING id";
export async function withdrawApplication(db: Queryable, userId: string, appId: string): Promise<Result<true>> {
  if (!UUID.test(appId) || (await db.query(WITHDRAW_SQL, [appId, userId])).rows.length === 0) return notFound;
  await db.query(CANCEL_APP_VIEWINGS_SQL, [appId]);
  await audit(db, userId, "rental_application", appId, "rental_application_withdrawn");
  return { ok: true, value: true };
}

const DECISIONS = { shortlist: "shortlisted", approve: "approved", decline: "declined" } as const;
export const DECIDE_SQL =
  "UPDATE rental_application a SET status = $3::text, decided_by = $2::uuid, decided_at = now(), updated_at = now() FROM property_listing l " +
  "WHERE a.id = $1::uuid AND l.id = a.listing_id AND l.owner_user_id = $2::uuid AND a.status NOT IN ('withdrawn') RETURNING a.id, a.listing_id, a.applicant_user_id";
/** The owner's decision, and only the owner's. Elena sends the applicant a fixed, neutral message; she never gives or hints at a reason. */
export async function decideApplication(db: Queryable, sender: RentalSender, ownerId: string, appId: string, action: unknown, now: string): Promise<Result<true>> {
  if (!UUID.test(appId) || (action !== "shortlist" && action !== "approve" && action !== "decline" && action !== "ask_info")) return fail("invalid", "Choose shortlist, approve, decline or ask for information.");
  const app = (await db.query(APP_BY_ID_SQL, [appId])).rows[0];
  if (!app) return notFound;
  const l = await ownRent(db, ownerId, str(app["listing_id"]));
  if (!l) return notFound;
  if (action === "ask_info") {
    const ev = evaluate(toApp(app), await getSettings(db, l.id), l.weeklyRentCents);
    if (ev.missing.length === 0) return fail("conflict", "Nothing is missing from this application.");
    if (!(await askForInfo(db, sender, appId, str(app["applicant_user_id"]), l, ev.missing, now))) return fail("rate_limited", "Elena has already asked this applicant, or has asked twice. Message them after they reply.");
    return { ok: true, value: true };
  }
  const status = DECISIONS[action];
  const row = (await db.query(DECIDE_SQL, [appId, ownerId, status])).rows[0];
  if (!row) return notFound;
  if (status === "declined") await db.query(CANCEL_APP_VIEWINGS_SQL, [appId]);
  await audit(db, ownerId, "rental_application", appId, `rental_application_${status}`, { listingId: l.id });
  const kind = status === "approved" ? "decision_approved" : status === "declined" ? "decision_declined" : "decision_shortlisted";
  await say(db, sender, { listingId: l.id, subjectType: "application", subjectId: appId, to: str(row["applicant_user_id"]), kind, vars: { address: l.address }, link: "/rentals", now, address: l.address });
  return { ok: true, value: true };
}

// ---- Viewings -------------------------------------------------------------------------------------------------------------------

export interface SlotView { id: string; startsAt: string; durationMin: number; capacity: number; booked: number; status: string }
export const SLOTS_SQL =
  "SELECT s.id, s.starts_at, s.duration_min, s.capacity, s.status, (SELECT count(*) FROM rental_viewing v WHERE v.slot_id = s.id AND v.status = 'booked')::int AS booked " +
  "FROM rental_viewing_slot s WHERE s.listing_id = $1::uuid AND s.starts_at >= now() - interval '1 day' ORDER BY s.starts_at LIMIT 100";
export async function slotsFor(db: Queryable, listingId: string): Promise<SlotView[]> {
  return (await db.query(SLOTS_SQL, [listingId])).rows.map(r => ({ id: str(r["id"]), startsAt: iso(r["starts_at"]), durationMin: Number(r["duration_min"]), capacity: Number(r["capacity"]), booked: Number(r["booked"]), status: str(r["status"]) }));
}

export const INSERT_SLOT_SQL = "INSERT INTO rental_viewing_slot (listing_id, starts_at, duration_min, capacity) VALUES ($1::uuid,$2::timestamptz,$3::integer,$4::integer) ON CONFLICT (listing_id, starts_at) DO NOTHING RETURNING id";
export async function addSlots(db: Queryable, sender: RentalSender, ownerId: string, listingId: string, input: unknown, now: string): Promise<Result<{ added: number }>> {
  const l = await ownRent(db, ownerId, listingId);
  if (!l) return notFound;
  const p = parseSlots(input, now);
  if (!p.ok) return p;
  const open = Number((await db.query("SELECT count(*)::int AS n FROM rental_viewing_slot WHERE listing_id = $1::uuid AND status = 'open' AND starts_at > now()", [listingId])).rows[0]?.["n"] ?? 0);
  if (open + p.value.length > RENTAL_LIMITS.maxSlots * 2) return fail("invalid", "There are already a lot of open viewing times. Cancel some first.");
  let added = 0;
  for (const s of p.value) added += (await db.query(INSERT_SLOT_SQL, [listingId, s.startsAt, s.durationMin, s.capacity])).rows.length;
  await audit(db, ownerId, "rental_settings", listingId, "rental_slots_added", { added });
  if (added > 0 && (await getSettings(db, listingId)).elenaOn) await offerToWaiting(db, sender, l, now);
  return { ok: true, value: { added } };
}

/** New times are offered to applicants who are still active and have no viewing booked, once each time the owner adds times. At most three times are listed. */
const WAITING_SQL =
  "SELECT a.id, a.applicant_user_id FROM rental_application a WHERE a.listing_id = $1::uuid AND a.status IN ('submitted','info_requested','shortlisted') " +
  "AND NOT EXISTS (SELECT 1 FROM rental_viewing v WHERE v.application_id = a.id AND v.status IN ('booked','attended')) ORDER BY a.created_at LIMIT 100";
async function offerToWaiting(db: Queryable, sender: RentalSender, l: RentListing, now: string): Promise<number> {
  const offers = pickOffers(await slotsFor(db, l.id), now);
  if (offers.length === 0) return 0;
  const list = offers.map(o => formatAppointment(o.startsAt, l.jurisdiction)).join("; ");
  let n = 0;
  for (const a of (await db.query(WAITING_SQL, [l.id])).rows) {
    const r = await say(db, sender, { listingId: l.id, subjectType: "application", subjectId: str(a["id"]), to: str(a["applicant_user_id"]), kind: "viewing_offer", vars: { address: l.address, list }, link: "/rentals", now, address: l.address });
    if (r === "sent") n++;
  }
  return n;
}

export const CANCEL_SLOT_SQL =
  "UPDATE rental_viewing_slot s SET status = 'cancelled' FROM property_listing l WHERE s.id = $1::uuid AND l.id = s.listing_id AND l.owner_user_id = $2::uuid AND s.status = 'open' RETURNING s.id, s.listing_id, s.starts_at";
export async function cancelSlot(db: Queryable, sender: RentalSender, ownerId: string, slotId: string, now: string): Promise<Result<{ notified: number }>> {
  if (!UUID.test(slotId)) return notFound;
  const s = (await db.query(CANCEL_SLOT_SQL, [slotId, ownerId])).rows[0];
  if (!s) return notFound;
  const l = (await rentListing(db, str(s["listing_id"])))!;
  const booked = (await db.query("UPDATE rental_viewing SET status = 'cancelled', updated_at = now() WHERE slot_id = $1::uuid AND status = 'booked' RETURNING application_id", [slotId])).rows;
  let notified = 0;
  for (const b of booked) {
    const a = (await db.query(APP_BY_ID_SQL, [str(b["application_id"])])).rows[0]!;
    if ((await say(db, sender, { listingId: l.id, subjectType: "viewing", subjectId: str(b["application_id"]), to: str(a["applicant_user_id"]), kind: "viewing_cancelled", vars: { address: l.address, when: formatAppointment(iso(s["starts_at"]), l.jurisdiction) }, link: "/rentals", now, address: l.address })) === "sent") notified++;
  }
  await audit(db, ownerId, "rental_viewing_slot", slotId, "rental_slot_cancelled", { notified });
  return { ok: true, value: { notified } };
}

export const LOCK_SLOT_SQL = "SELECT s.id, s.listing_id, s.starts_at, s.capacity, s.status FROM rental_viewing_slot s WHERE s.id = $1::uuid FOR UPDATE";
/** Places taken on a slot by other applications (params: 1 slot, 2 this application, whose own booking on the slot does not count against it). */
export const BOOKED_COUNT_SQL = "SELECT count(*)::int AS n FROM rental_viewing WHERE slot_id = $1::uuid AND status = 'booked' AND application_id <> $2::uuid";
/**
 * The applicant picks one of the owner's times. The slot row is locked, so two people cannot take the last place. Booking again moves the
 * viewing: the earlier booking is cancelled in the same transaction. Only the applicant, only for their own live application.
 */
export async function bookViewing(db: Queryable, sender: RentalSender, userId: string, appId: string, slotId: string, now: string): Promise<Result<{ viewingId: string; startsAt: string }>> {
  if (!UUID.test(appId) || !UUID.test(slotId)) return notFound;
  const app = (await db.query(APP_BY_ID_SQL, [appId])).rows[0];
  if (!app || str(app["applicant_user_id"]) !== userId) return notFound;
  if (!["submitted", "info_requested", "shortlisted", "approved"].includes(str(app["status"]))) return fail("conflict", "This application is closed, so a viewing cannot be booked.");
  const run = async (tx: Queryable): Promise<Result<{ viewingId: string; startsAt: string; listingId: string }>> => {
    // Lock the application, then the slot: a withdrawal or a second booking cannot slip in between the checks and the write.
    const live = (await tx.query("SELECT status FROM rental_application WHERE id = $1::uuid AND applicant_user_id = $2::uuid FOR UPDATE", [appId, userId])).rows[0];
    if (!live || !["submitted", "info_requested", "shortlisted", "approved"].includes(str(live["status"]))) return fail("conflict", "This application is closed, so a viewing cannot be booked.");
    const s = (await tx.query(LOCK_SLOT_SQL, [slotId])).rows[0];
    if (!s || str(s["listing_id"]) !== str(app["listing_id"]) || s["status"] !== "open") return fail("not_found", "That time is no longer available.");
    const startsAt = iso(s["starts_at"]);
    if (Date.parse(startsAt) < Date.parse(now) + RENTAL_LIMITS.minLeadMinutes * 60_000) return fail("conflict", "That time is too soon to book.");
    // Everything is checked before anything is changed, so a refused re-booking never cancels the viewing the person already has.
    if (Number((await tx.query(BOOKED_COUNT_SQL, [slotId, appId])).rows[0]?.["n"]) >= Number(s["capacity"])) return fail("conflict", "That time just filled up. Pick another.");
    await tx.query("UPDATE rental_viewing SET status = 'cancelled', updated_at = now() WHERE application_id = $1::uuid AND status = 'booked'", [appId]);
    const v = (await tx.query("INSERT INTO rental_viewing (slot_id, application_id) VALUES ($1::uuid,$2::uuid) RETURNING id", [slotId, appId])).rows[0]!;
    return { ok: true, value: { viewingId: str(v["id"]), startsAt, listingId: str(s["listing_id"]) } };
  };
  const r = db.transaction ? await db.transaction(run) : await run(db);
  if (!r.ok) return r;
  const l = (await rentListing(db, r.value.listingId))!;
  const when = formatAppointment(r.value.startsAt, l.jurisdiction);
  await audit(db, userId, "rental_viewing", r.value.viewingId, "rental_viewing_booked", { listingId: l.id });
  await say(db, sender, { listingId: l.id, subjectType: "viewing", subjectId: appId, to: userId, kind: "viewing_confirmed", vars: { address: l.address, when }, link: "/rentals", now, address: l.address });
  await say(db, sender, { listingId: l.id, subjectType: "viewing", subjectId: appId, to: l.ownerId, kind: "viewing_confirmed_owner", vars: { address: l.address, when, name: await ownerLabel(db, appId) }, link: `/listings/${l.id}/rentals`, now, address: l.address });
  return { ok: true, value: { viewingId: r.value.viewingId, startsAt: r.value.startsAt } };
}

export async function cancelViewing(db: Queryable, sender: RentalSender, userId: string, appId: string, now: string): Promise<Result<true>> {
  if (!UUID.test(appId)) return notFound;
  const app = (await db.query(APP_BY_ID_SQL, [appId])).rows[0];
  if (!app || str(app["applicant_user_id"]) !== userId) return notFound;
  const v = (await db.query("UPDATE rental_viewing SET status = 'cancelled', updated_at = now() WHERE application_id = $1::uuid AND status = 'booked' RETURNING slot_id", [appId])).rows[0];
  if (!v) return notFound;
  const l = (await rentListing(db, str(app["listing_id"])))!;
  const slot = (await db.query("SELECT starts_at FROM rental_viewing_slot WHERE id = $1::uuid", [str(v["slot_id"])])).rows[0]!;
  await audit(db, userId, "rental_viewing", appId, "rental_viewing_cancelled", { listingId: l.id });
  await say(db, sender, { listingId: l.id, subjectType: "viewing", subjectId: appId, to: l.ownerId, kind: "viewing_cancelled_owner", vars: { address: l.address, when: formatAppointment(iso(slot["starts_at"]), l.jurisdiction), name: await ownerLabel(db, appId) }, link: `/listings/${l.id}/rentals`, now, address: l.address });
  return { ok: true, value: true };
}

/** The owner records who came. Only after the viewing has started. */
export const MARK_ATTENDANCE_SQL =
  "UPDATE rental_viewing v SET status = $3::text, updated_at = now() FROM rental_viewing_slot s, property_listing l WHERE v.application_id = $1::uuid AND v.status IN ('booked','attended','no_show') AND s.id = v.slot_id AND l.id = s.listing_id AND l.owner_user_id = $2::uuid AND s.starts_at <= now() RETURNING v.id";
export async function markAttendance(db: Queryable, ownerId: string, appId: string, attended: boolean): Promise<Result<true>> {
  if (!UUID.test(appId) || (await db.query(MARK_ATTENDANCE_SQL, [appId, ownerId, attended ? "attended" : "no_show"])).rows.length === 0) return notFound;
  return { ok: true, value: true };
}

// ---- Tenancies ------------------------------------------------------------------------------------------------------------------

export const INSERT_TENANCY_SQL =
  "INSERT INTO rental_tenancy (listing_id, tenant_user_id, created_by) SELECT l.id, u.id, $2::uuid FROM property_listing l, app_user u " +
  "WHERE l.id = $1::uuid AND l.owner_user_id = $2::uuid AND l.transaction_type = 'rent' AND u.id = $3::uuid AND u.id <> l.owner_user_id AND u.status NOT IN ('suspended','closed') " +
  "ON CONFLICT (listing_id, tenant_user_id) DO UPDATE SET status = 'active' RETURNING id";
/** The owner makes someone a tenant: from an approved application, or by the email of a person who already has an account. */
export async function startTenancy(db: Queryable, sender: RentalSender, ownerId: string, listingId: string, input: unknown, now: string): Promise<Result<{ id: string }>> {
  const l = await ownRent(db, ownerId, listingId);
  if (!l) return notFound;
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  let tenantId: string | undefined;
  if (typeof o["applicationId"] === "string" && UUID.test(o["applicationId"])) {
    const a = (await db.query(APP_BY_ID_SQL, [o["applicationId"]])).rows[0];
    if (!a || str(a["listing_id"]) !== listingId) return notFound;
    if (a["status"] !== "approved") return fail("conflict", "Approve the application first.");
    tenantId = str(a["applicant_user_id"]);
  } else if (typeof o["email"] === "string" && o["email"].includes("@") && o["email"].length <= 254) {
    // Looking people up by email is limited per owner, and a miss gives the same answer as any other refusal.
    if (!(await withinRates(db, "rental-tenant-lookup", [ownerId], { windowMs: 3600_000, limit: 10 }, new Date(now)))) return fail("rate_limited", "You have added a lot of tenants just now. Try again later.");
    const u = (await db.query("SELECT id FROM app_user WHERE email = $1::citext", [o["email"].trim().toLowerCase()])).rows[0];
    if (!u) return fail("invalid", "That person could not be added. Check the email address, and that they already have an account.");
    tenantId = str(u["id"]);
  } else return fail("invalid", "Choose an approved application or enter the tenant's email.");
  const t = (await db.query(INSERT_TENANCY_SQL, [listingId, ownerId, tenantId])).rows[0];
  if (!t) return fail("invalid", "That person cannot be made a tenant.");
  await audit(db, ownerId, "rental_tenancy", str(t["id"]), "rental_tenancy_started", { listingId });
  await say(db, sender, { listingId, subjectType: "application", subjectId: str(t["id"]), to: tenantId, kind: "tenancy_started", vars: { address: l.address }, link: "/rentals", now, address: l.address });
  return { ok: true, value: { id: str(t["id"]) } };
}
export async function endTenancy(db: Queryable, ownerId: string, tenancyId: string): Promise<Result<true>> {
  if (!UUID.test(tenancyId)) return notFound;
  const r = await db.query("UPDATE rental_tenancy t SET status = 'ended' FROM property_listing l WHERE t.id = $1::uuid AND l.id = t.listing_id AND l.owner_user_id = $2::uuid AND t.status = 'active' RETURNING t.id", [tenancyId, ownerId]);
  if (r.rows.length === 0) return notFound;
  await audit(db, ownerId, "rental_tenancy", tenancyId, "rental_tenancy_ended");
  return { ok: true, value: true };
}

// ---- Repairs --------------------------------------------------------------------------------------------------------------------

export interface RepairRow {
  id: string; no: number; listingId: string; ownerId: string; tenantId: string; tenantName: string; address: string; category: RepairCategory; description: string; urgency: Urgency; urgencyReason: string;
  trade?: string; status: RepairStatus; proposedContractorId?: string; proposedContractorName?: string; proposedReasons: string[]; assignmentId?: string; emergencyRequestId?: string; chases: number;
  nextActionAt?: string; offeredAt?: string; tenantConsentAt?: string; noticeSentAt?: string; needsOwnerReason?: string; askedContractorIds: string[]; createdAt: string; closedAt?: string;
}
const REPAIR_COLS =
  "r.id, r.repair_no, r.listing_id, r.owner_user_id, r.tenant_user_id, tu.display_name AS tenant_name, l.address_text, r.category, r.description, r.urgency, r.urgency_reason, r.trade, r.status, " +
  "r.proposed_contractor_id, pc.display_name AS proposed_name, r.proposed_reasons, r.assignment_id, r.emergency_request_id, r.chases, r.next_action_at, r.offered_at, r.tenant_consent_at, r.notice_sent_at, " +
  "r.needs_owner_reason, r.asked_contractor_ids, r.created_at, r.closed_at";
const REPAIR_FROM = " FROM rental_repair r JOIN property_listing l ON l.id = r.listing_id JOIN app_user tu ON tu.id = r.tenant_user_id LEFT JOIN app_user pc ON pc.id = r.proposed_contractor_id";
const toRepair = (r: Record<string, unknown>): RepairRow => ({
  id: str(r["id"]), no: Number(r["repair_no"]), listingId: str(r["listing_id"]), ownerId: str(r["owner_user_id"]), tenantId: str(r["tenant_user_id"]), tenantName: str(r["tenant_name"]), address: str(r["address_text"]),
  category: str(r["category"]) as RepairCategory, description: str(r["description"]), urgency: str(r["urgency"]) as Urgency, urgencyReason: str(r["urgency_reason"]), ...(r["trade"] ? { trade: str(r["trade"]) } : {}),
  status: str(r["status"]) as RepairStatus, ...(r["proposed_contractor_id"] ? { proposedContractorId: str(r["proposed_contractor_id"]), proposedContractorName: str(r["proposed_name"]) } : {}),
  proposedReasons: (r["proposed_reasons"] as string[] | null) ?? [], ...(r["assignment_id"] ? { assignmentId: str(r["assignment_id"]) } : {}), ...(r["emergency_request_id"] ? { emergencyRequestId: str(r["emergency_request_id"]) } : {}),
  chases: Number(r["chases"]), ...(optIso(r["next_action_at"]) ? { nextActionAt: optIso(r["next_action_at"])! } : {}), ...(optIso(r["offered_at"]) ? { offeredAt: optIso(r["offered_at"])! } : {}),
  ...(optIso(r["tenant_consent_at"]) ? { tenantConsentAt: optIso(r["tenant_consent_at"])! } : {}), ...(optIso(r["notice_sent_at"]) ? { noticeSentAt: optIso(r["notice_sent_at"])! } : {}),
  ...(optStr(r["needs_owner_reason"]) ? { needsOwnerReason: str(r["needs_owner_reason"]) } : {}), askedContractorIds: ((r["asked_contractor_ids"] as string[] | null) ?? []).map(String), createdAt: iso(r["created_at"]), ...(optIso(r["closed_at"]) ? { closedAt: optIso(r["closed_at"])! } : {})
});
export const REPAIR_BY_ID_SQL = `SELECT ${REPAIR_COLS}${REPAIR_FROM} WHERE r.id = $1::uuid`;
export const REPAIRS_FOR_LISTING_SQL = `SELECT ${REPAIR_COLS}${REPAIR_FROM} WHERE r.listing_id = $1::uuid ORDER BY r.created_at DESC LIMIT 100`;
export const REPAIRS_FOR_TENANT_SQL = `SELECT ${REPAIR_COLS}${REPAIR_FROM} WHERE r.tenant_user_id = $1::uuid ORDER BY r.created_at DESC LIMIT 50`;
export const PHOTOS_SQL = "SELECT id, repair_id FROM rental_repair_photo WHERE repair_id = ANY($1::uuid[]) ORDER BY created_at";

export interface PhotoUpload { bytes: Uint8Array }
export interface RepairOutcome { id: string; ref: string; urgency: Urgency; reason: string; advice?: string; emergencySent: boolean; message?: string }
const refOf = (no: number) => `RR-${no}`;
const ownerLink = (listingId: string) => `/listings/${listingId}/rentals`;

export const TENANCY_FOR_TENANT_SQL =
  "SELECT t.id, t.listing_id, l.owner_user_id, l.address_text FROM rental_tenancy t JOIN property_listing l ON l.id = t.listing_id WHERE t.id = $1::uuid AND t.tenant_user_id = $2::uuid AND t.status = 'active'";
export const INSERT_REPAIR_SQL =
  "INSERT INTO rental_repair (tenancy_id, listing_id, tenant_user_id, owner_user_id, category, description, urgency, urgency_reason, trade, status, next_action_at) " +
  "VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::timestamptz) RETURNING id, repair_no";

/**
 * A tenant reports a problem. Elena sorts it by fixed rules, tells the tenant what to do first (call 000 if anyone is in danger), tells the owner
 * how urgent it is, and then either proposes a contractor for the owner to approve, or, where the owner turned it on, sends the offer herself.
 * Emergencies go to the emergency contractor flow only where the owner turned that on; otherwise the owner gets an urgent alert with one button.
 */
export async function submitRepair(db: Queryable, sender: RentalSender, env: Env, tenantId: string, input: unknown, photos: readonly PhotoUpload[], now: string, scanner?: MalwareScanPort): Promise<Result<RepairOutcome>> {
  const p = parseRepair(input);
  if (!p.ok) return p;
  const t = (await db.query(TENANCY_FOR_TENANT_SQL, [p.value.tenancyId, tenantId])).rows[0];
  if (!t) return notFound;
  if (photos.length > RENTAL_LIMITS.maxPhotos) return fail("invalid", `Add up to ${RENTAL_LIMITS.maxPhotos} photos.`);
  const clean: { mime: string; bytes: Uint8Array }[] = [];
  for (const ph of photos) {
    const mime = sniffMime(ph.bytes);
    if (ph.bytes.byteLength === 0 || ph.bytes.byteLength > RENTAL_LIMITS.maxPhotoBytes || (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp")) return fail("invalid", "Photos must be JPEG, PNG or WebP, up to 2 MB each.");
    // Same intake as the other upload paths: metadata (EXIF/GPS) stripped, then a malware scan. Nothing is stored unless both pass.
    const stripped = stripImageMetadata(ph.bytes, mime);
    if (!stripped.ok) return fail("invalid", "One of the photos could not be read. Try another.");
    if (!scanner || !scanner.configured) return fail("unavailable", "Photo upload is not available right now. Send the report without photos.");
    if ((await scanner.scan(stripped.bytes).catch(() => "error")) !== "clean") return fail("invalid", "A photo did not pass the security scan.");
    clean.push({ mime, bytes: stripped.bytes });
  }
  if (!(await withinRates(db, "rental-repair-hour", [tenantId], { windowMs: 3600_000, limit: RENTAL_LIMITS.repairsPerHour }, new Date(now))) ||
      !(await withinRates(db, "rental-repair-day", [tenantId], { windowMs: 24 * 3600_000, limit: RENTAL_LIMITS.repairsPerDay }, new Date(now)))) return fail("rate_limited", "You have sent several repair requests. Add to an existing request instead, or try again later.");
  const listingId = str(t["listing_id"]), ownerId = str(t["owner_user_id"]), address = str(t["address_text"]);
  const settings = await getSettings(db, listingId);
  const tri = triage(p.value.category, p.value.description, p.value.emergency, p.value.urgent);
  const trade = tri.urgency === "emergency" ? emergencyTradeFor(p.value.category, tri) : null;
  const status: RepairStatus = "awaiting_owner";
  const next = new Date(new Date(now).getTime() + (tri.urgency === "emergency" ? 3600_000 : tri.urgency === "urgent" ? 6 * 3600_000 : 24 * 3600_000)).toISOString();
  const row = (await db.query(INSERT_REPAIR_SQL, [p.value.tenancyId, listingId, tenantId, ownerId, p.value.category, p.value.description, tri.urgency, tri.reason, trade, status, settings.elenaOn ? next : null])).rows[0]!;
  const id = str(row["id"]), ref = refOf(Number(row["repair_no"]));
  for (const ph of clean) await db.query("INSERT INTO rental_repair_photo (repair_id, mime, bytes) VALUES ($1::uuid,$2::text,$3::bytea)", [id, ph.mime, Buffer.from(ph.bytes)]);
  await audit(db, tenantId, "rental_repair", id, "rental_repair_reported", { listingId, urgency: tri.urgency, category: p.value.category, photos: clean.length });
  const base = { listingId, subjectType: "repair" as const, subjectId: id, now, address };
  const vars = { address, ref, category: REPAIR_LABELS[p.value.category], urgency: tri.urgency, reason: tri.reason, ...(tri.advice ? { advice: tri.advice } : {}) };
  await say(db, sender, { ...base, to: tenantId, kind: "repair_received", vars, link: "/rentals" });
  let emergencySent = false;
  let message: string | undefined;
  if (tri.urgency === "emergency") {
    await say(db, sender, { ...base, to: ownerId, kind: "repair_emergency_owner", vars, link: ownerLink(listingId) });
    // A tenant's own "emergency" tick is not enough to contact contractors automatically: only a fixed safety rule (gas, fire, flooding...) is.
    const ruleMatched = triage(p.value.category, p.value.description, false, false).urgency === "emergency";
    if (settings.elenaOn && settings.autoEmergency && ruleMatched) {
      const sent = await dispatchEmergency(db, sender, env, (await getRepair(db, id))!, now);
      emergencySent = sent.ok;
      if (!sent.ok) message = sent.message;
    }
  } else {
    await say(db, sender, { ...base, to: ownerId, kind: "repair_owner_new", vars, link: ownerLink(listingId) });
    if (settings.elenaOn) await proposeAndMaybeOffer(db, sender, env, (await getRepair(db, id))!, settings, now);
  }
  return { ok: true, value: { id, ref, urgency: tri.urgency, reason: tri.reason, ...(tri.advice ? { advice: tri.advice } : {}), emergencySent, ...(message ? { message } : {}) } };
}

export async function getRepair(db: Queryable, id: string): Promise<RepairRow | undefined> {
  const r = (await db.query(REPAIR_BY_ID_SQL, [id])).rows[0];
  return r ? toRepair(r) : undefined;
}

const ACTOR = (ownerId: string) => ({ userId: ownerId, userType: "owner" as const });
const deps = (db: Queryable) => ({ assignments: createPgAssignmentRepository(db), store: createPgMarketStore(db), ids: assignmentIds, notify: makeJobNotify(db) });
const TRADE_WORDS: Record<RepairCategory, RegExp> = {
  plumbing: /plumb|drain|gas ?fit/i, electrical: /electric|sparky/i, gas: /gas/i, appliance: /appliance|whitegoods|repair/i, heating_cooling: /air ?con|heating|cooling|hvac|refrigerat/i,
  locks_security: /lock|security|handyman|carpent/i, windows_doors: /glaz|window|door|carpent|handyman/i, roof_leaks: /roof|plumb|gutter|waterproof/i, pests: /pest|termite|exterminat/i,
  structure: /build|carpent|plaster|handyman|paint/i, other: /handyman|maintenance|general/i
};

/**
 * Elena's suggestion for a repair: the best-ranked contractor in the listing's area who takes "other trade" jobs, is staff-verified, insured in
 * date and not suspended, has not already been asked about this repair, with a trade that fits the problem first. Stored for the owner to approve.
 * Where the owner switched on automatic offers (and it is not an emergency), the offer is sent straight away through the normal job flow.
 */
export async function proposeAndMaybeOffer(db: Queryable, sender: RentalSender, env: Env, repair: RepairRow, settings: RentalSettings, now: string): Promise<"proposed" | "offered" | "none"> {
  const l = (await rentListing(db, repair.listingId))!;
  const ranked = await suggestFor(deps(db), ACTOR(repair.ownerId), repair.listingId, "other");
  const asked = new Set(repair.askedContractorIds);
  const ok = ranked.ok && ranked.value.length ? new Set((await db.query(ELIGIBLE_SQL, [ranked.value.map(r => r.card.userId)])).rows.map(r => str(r["id"]))) : new Set<string>();
  const pool = ranked.ok ? ranked.value.filter(r => ok.has(r.card.userId) && !asked.has(r.card.userId)) : [];
  const fit = pool.filter(r => TRADE_WORDS[repair.category].test(`${r.card.tradeLabel} ${r.card.headline}`));
  const pick = (fit.length ? fit : pool)[0];
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  if (!pick) {
    await db.query("UPDATE rental_repair SET proposed_contractor_id = NULL, proposed_reasons = '{}', updated_at = now() WHERE id = $1::uuid", [repair.id]);
    return "none";
  }
  const reasons = pick.reasons.slice(0, 3);
  await db.query("UPDATE rental_repair SET proposed_contractor_id = $2::uuid, proposed_reasons = $3::text[], updated_at = now() WHERE id = $1::uuid", [repair.id, pick.card.userId, reasons]);
  if (settings.autoRepairOffers && repair.urgency !== "emergency") {
    const r = await offerRepair(db, sender, { ...repair, proposedContractorId: pick.card.userId, proposedContractorName: pick.card.name }, now, "elena");
    if (r.ok) return "offered";
  }
  await say(db, sender, { ...base, to: repair.ownerId, kind: "repair_proposal", vars: { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category], contractor: pick.card.name, reason: reasons.join(", ") }, link: ownerLink(repair.listingId) });
  return "proposed";
}

/** Sends the job offer for a repair through the normal job flow: no price, a short note, the tenant's photos only after the contractor accepts. */
async function offerRepair(db: Queryable, sender: RentalSender, repair: RepairRow, now: string, by: "owner" | "elena"): Promise<Result<{ assignmentId: string }>> {
  if (!repair.proposedContractorId) return fail("conflict", "There is no contractor to ask yet.");
  const l = (await rentListing(db, repair.listingId))!;
  const note = `Rental repair ${refOf(repair.no)} (${REPAIR_LABELS[repair.category]}, ${repair.urgency}): ${repair.description.slice(0, 600)}`;
  // The contractor may have been suspended or lost insurance since Elena proposed them.
  if ((await db.query(ELIGIBLE_SQL, [[repair.proposedContractorId]])).rows.length === 0) return fail("conflict", "That contractor is no longer verified, insured and available. Choose another.");
  // Claim the repair first, so two approvals (or an approval and Elena's automatic offer) cannot send two job offers.
  if ((await db.query("UPDATE rental_repair SET status = 'offered', updated_at = now() WHERE id = $1::uuid AND status IN ('awaiting_owner','needs_owner') RETURNING id", [repair.id])).rows.length === 0) return fail("conflict", "This repair is not waiting for approval.");
  const booked = await bookContractor(deps(db), ACTOR(repair.ownerId), repair.listingId, { kind: "other", contractorUserId: repair.proposedContractorId, note }, "elena");
  if (!booked.ok) {
    await db.query("UPDATE rental_repair SET status = $2::text, updated_at = now() WHERE id = $1::uuid AND status = 'offered' AND assignment_id IS NULL", [repair.id, repair.status]);
    return booked;
  }
  const nextAt = new Date(new Date(now).getTime() + 2 * 3600_000).toISOString();
  await db.query(
    "UPDATE rental_repair SET status = 'offered', assignment_id = $2::uuid, offered_at = $3::timestamptz, chases = 0, next_action_at = $4::timestamptz, asked_contractor_ids = array_append(asked_contractor_ids, $5::uuid), updated_at = now() WHERE id = $1::uuid",
    [repair.id, booked.value.id, now, nextAt, repair.proposedContractorId]);
  await audit(db, by === "owner" ? repair.ownerId : "elena", "rental_repair", repair.id, "rental_repair_offered", { assignmentId: booked.value.id, by });
  const v = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category], contractor: first(repair.proposedContractorName ?? "a contractor") };
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  await say(db, sender, { ...base, to: repair.tenantId, kind: "repair_offered", vars: v, link: "/rentals" });
  if (by === "elena") await say(db, sender, { ...base, to: repair.ownerId, kind: "repair_offered", vars: v, link: ownerLink(repair.listingId) });
  return { ok: true, value: { assignmentId: booked.value.id } };
}

/** Sends the emergency request on the owner's behalf through the emergency contractor flow (rate limits, content filter, logged sends all apply there). */
async function dispatchEmergency(db: Queryable, sender: RentalSender, env: Env, repair: RepairRow, now: string, requesterId: string = repair.ownerId): Promise<{ ok: true } | { ok: false; message: string }> {
  // Claim first: a second click, or a click racing the automatic send, finds it already taken and sends nothing.
  if ((await db.query("UPDATE rental_repair SET status = 'emergency', updated_at = now() WHERE id = $1::uuid AND urgency = 'emergency' AND status NOT IN ('emergency','closed') RETURNING id", [repair.id])).rows.length === 0) return { ok: false, message: "It has already been sent." };
  const release = () => db.query("UPDATE rental_repair SET status = $2::text, updated_at = now() WHERE id = $1::uuid AND status = 'emergency' AND emergency_request_id IS NULL", [repair.id, repair.status]);
  const l = (await rentListing(db, repair.listingId))!;
  const trade = (repair.trade as Parameters<typeof emergencyTradeFor>[1]["trade"]) ?? emergencyTradeFor(repair.category, { urgency: "emergency", reason: "" });
  const out = await submitUrgentRequest(db, env, { userId: requesterId, userType: "owner" }, {
    trade, listingId: repair.listingId, propertyKind: "rental", description: `Rental repair ${refOf(repair.no)}, ${REPAIR_LABELS[repair.category]}: ${repair.description.slice(0, 500)}`
  }, now);
  if (!out.ok) { await release(); return { ok: false, message: out.message }; }
  await db.query("UPDATE rental_repair SET status = 'emergency', emergency_request_id = $2::uuid, chases = 0, next_action_at = $3::timestamptz, updated_at = now() WHERE id = $1::uuid", [repair.id, out.value.id, new Date(new Date(now).getTime() + 10 * 60_000).toISOString()]);
  await audit(db, "elena", "rental_repair", repair.id, "rental_repair_emergency_sent", { emergencyRequestId: out.value.id, contacted: out.value.contacted });
  const v = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category] };
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  await say(db, sender, { ...base, to: repair.tenantId, kind: "repair_emergency_sent", vars: v, link: "/rentals" });
  await say(db, sender, { ...base, to: repair.ownerId, kind: "repair_emergency_sent", vars: v, link: "/emergency" });
  return { ok: true };
}

const OWNER_ACTIONS = ["approve", "choose_other", "arrange_myself", "send_emergency", "close", "reopen"] as const;
export type OwnerRepairAction = (typeof OWNER_ACTIONS)[number];

/** What the owner can do with a repair. Only the owner of the listing; every action is audited. */
export async function ownerRepairAction(db: Queryable, sender: RentalSender, env: Env, ownerId: string, repairId: string, action: unknown, now: string): Promise<Result<{ message?: string }>> {
  if (!UUID.test(repairId) || typeof action !== "string" || !(OWNER_ACTIONS as readonly string[]).includes(action)) return fail("invalid", "Choose an action.");
  const repair = await getRepair(db, repairId);
  if (!repair || repair.ownerId !== ownerId) return notFound;
  const l = (await rentListing(db, repair.listingId))!;
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  const v = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category] };
  switch (action as OwnerRepairAction) {
    case "approve": {
      if (repair.status !== "awaiting_owner" && repair.status !== "needs_owner") return fail("conflict", "This repair is not waiting for approval.");
      const r = await offerRepair(db, sender, repair, now, "owner");
      return r.ok ? { ok: true, value: {} } : r;
    }
    case "choose_other": {
      if (repair.status !== "awaiting_owner" && repair.status !== "needs_owner") return fail("conflict", "This repair is not waiting for approval.");
      const asked = repair.proposedContractorId ? [...repair.askedContractorIds, repair.proposedContractorId] : repair.askedContractorIds;
      const r2 = await proposeAndMaybeOffer(db, sender, env, { ...repair, askedContractorIds: asked }, { ...(await getSettings(db, repair.listingId)), autoRepairOffers: false }, now);
      return { ok: true, value: r2 === "none" ? { message: "No other verified contractor in your area is taking these jobs. Browse the list or arrange it yourself." } : {} };
    }
    case "arrange_myself":
      await db.query("UPDATE rental_repair SET status = 'owner_arranging', next_action_at = $2::timestamptz, chases = 0, updated_at = now() WHERE id = $1::uuid AND status NOT IN ('closed')", [repair.id, new Date(new Date(now).getTime() + 48 * 3600_000).toISOString()]);
      await audit(db, ownerId, "rental_repair", repair.id, "rental_repair_owner_arranging");
      await say(db, sender, { ...base, to: repair.tenantId, kind: "repair_owner_arranging", vars: v, link: "/rentals" });
      return { ok: true, value: {} };
    case "send_emergency": {
      if (repair.urgency !== "emergency" || repair.status === "closed") return fail("conflict", "Only an open emergency can be sent to emergency contractors.");
      if (repair.status === "emergency") return fail("conflict", "It has already been sent.");
      const r = await dispatchEmergency(db, sender, env, repair, now);
      return r.ok ? { ok: true, value: {} } : fail("conflict", r.message);
    }
    case "close":
      await closeRepair(db, sender, repair, ownerId, now);
      return { ok: true, value: {} };
    case "reopen":
      if (repair.status !== "needs_owner" && repair.status !== "closed") return fail("conflict", "Only a stopped or closed repair can be reopened.");
      await db.query("UPDATE rental_repair SET status = 'awaiting_owner', chases = 0, closed_at = NULL, needs_owner_reason = NULL, next_action_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid", [repair.id, new Date(new Date(now).getTime() + 24 * 3600_000).toISOString()]);
      await audit(db, ownerId, "rental_repair", repair.id, "rental_repair_reopened");
      return { ok: true, value: {} };
  }
}

async function closeRepair(db: Queryable, sender: RentalSender, repair: RepairRow, actorId: string, now: string): Promise<void> {
  const r = await db.query("UPDATE rental_repair SET status = 'closed', closed_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1::uuid AND status <> 'closed' RETURNING id", [repair.id]);
  if (r.rows.length === 0) return;
  await audit(db, actorId, "rental_repair", repair.id, "rental_repair_closed");
  const l = (await rentListing(db, repair.listingId))!;
  const v = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category] };
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  await say(db, sender, { ...base, to: repair.tenantId, kind: "repair_closed", vars: v, link: "/rentals" });
  if (actorId !== repair.ownerId) await say(db, sender, { ...base, to: repair.ownerId, kind: "repair_closed", vars: v, link: ownerLink(repair.listingId) });
}

/** What the tenant can do: say it is fixed or not, agree to a visit with less than 24 hours' notice, or cancel the request. */
export async function tenantRepairAction(db: Queryable, sender: RentalSender, env: Env, tenantId: string, repairId: string, action: unknown, now: string): Promise<Result<true>> {
  if (!UUID.test(repairId) || (action !== "fixed" && action !== "not_fixed" && action !== "consent_visit" && action !== "cancel")) return fail("invalid", "Choose an action.");
  const repair = await getRepair(db, repairId);
  if (!repair || repair.tenantId !== tenantId) return notFound;
  const l = (await rentListing(db, repair.listingId))!;
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  const v = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category] };
  if (action === "fixed" || action === "cancel") {
    if (repair.status === "closed") return fail("conflict", "It is already closed.");
    await closeRepair(db, sender, repair, tenantId, now);
    return { ok: true, value: true };
  }
  if (action === "not_fixed") {
    if (repair.status !== "check_in" && repair.status !== "closed" && repair.status !== "needs_owner") return fail("conflict", "There is nothing to reopen yet.");
    await db.query("UPDATE rental_repair SET status = 'awaiting_owner', chases = 0, closed_at = NULL, needs_owner_reason = NULL, assignment_id = NULL, next_action_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid", [repair.id, new Date(new Date(now).getTime() + chaseGap(repair.urgency)).toISOString()]);
    await audit(db, tenantId, "rental_repair", repair.id, "rental_repair_not_fixed");
    await say(db, sender, { ...base, to: repair.ownerId, kind: "repair_reopened", vars: v, link: ownerLink(repair.listingId) });
    const settings = await getSettings(db, repair.listingId);
    if (settings.elenaOn && repair.urgency !== "emergency") await proposeAndMaybeOffer(db, sender, env, { ...(await getRepair(db, repair.id))!, askedContractorIds: repair.askedContractorIds }, { ...settings, autoRepairOffers: false }, now);
    return { ok: true, value: true };
  }
  // consent_visit
  if (repair.status !== "scheduled") return fail("conflict", "There is no visit to agree to yet.");
  await db.query("UPDATE rental_repair SET tenant_consent_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid", [repair.id, now]);
  await audit(db, tenantId, "rental_repair", repair.id, "rental_repair_visit_consent");
  await sendVisitNotice(db, sender, (await getRepair(db, repair.id))!, now);
  return { ok: true, value: true };
}
const chaseGap = (u: Urgency) => (u === "emergency" ? 3600_000 : u === "urgent" ? 6 * 3600_000 : 24 * 3600_000);

export const REPAIR_VISIT_SQL =
  "SELECT a.status, a.scheduled_time, a.completed_at, v.starts_at, v.ends_at, v.state AS visit_state FROM job_assignment a LEFT JOIN job_visit v ON v.assignment_id = a.id WHERE a.id = $1::uuid";
interface VisitFacts { status: RepairContext["assignmentStatus"]; scheduledAt?: string; endsAt?: string }
async function visitFacts(db: Queryable, assignmentId: string | undefined): Promise<VisitFacts> {
  if (!assignmentId) return { status: "none" };
  const r = (await db.query(REPAIR_VISIT_SQL, [assignmentId])).rows[0];
  if (!r) return { status: "none" };
  const status = str(r["status"]) as VisitFacts["status"];
  const visit = r["visit_state"] === "confirmed" ? iso(r["starts_at"]) : undefined;
  const at = visit ?? optIso(r["scheduled_time"]);
  return { status: r["completed_at"] ? "completed" : status, ...(at ? { scheduledAt: at } : {}), ...(visit ? { endsAt: iso(r["ends_at"]) } : {}) };
}

/**
 * Tenant notice for a contractor visit, by the rules of the contractor operations package: a visit 24 hours or more away gets an entry notice
 * (in-app, and by email through the job's tenant notice log). Sooner than that, nobody enters unless the tenant says yes. Emergencies skip notice.
 */
async function sendVisitNotice(db: Queryable, sender: RentalSender, repair: RepairRow, now: string): Promise<void> {
  if (!repair.assignmentId || repair.noticeSentAt) return;
  const f = await visitFacts(db, repair.assignmentId);
  if (!f.scheduledAt || f.status === "cancelled") return;
  const l = (await rentListing(db, repair.listingId))!;
  const base = { listingId: repair.listingId, subjectType: "repair" as const, subjectId: repair.id, now, address: l.address };
  const when = formatAppointment(f.scheduledAt, l.jurisdiction);
  const v = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category], when };
  if (needsTenantConsent(f.scheduledAt, now, repair.urgency === "emergency") && !repair.tenantConsentAt) {
    const already = (await db.query("SELECT 1 FROM rental_message WHERE subject_id = $1::uuid AND kind = 'repair_short_notice' AND status = 'sent' LIMIT 1", [repair.id])).rows.length > 0;
    if (!already) await say(db, sender, { ...base, to: repair.tenantId, kind: "repair_short_notice", vars: v, link: "/rentals" });
    return;
  }
  if ((await say(db, sender, { ...base, to: repair.tenantId, kind: "repair_notice", vars: v, link: "/rentals" })) !== "sent") return;
  await db.query("UPDATE rental_repair SET notice_sent_at = $2::timestamptz WHERE id = $1::uuid", [repair.id, now]);
  // The email notice goes through the same tenant notice log and limits as an owner's own notice (#349). Failure to email never blocks the in-app notice.
  try {
    const job = await getJobContext(db, repair.assignmentId, repair.ownerId);
    const tenant = (await db.query("SELECT display_name, email FROM app_user WHERE id = $1::uuid", [repair.tenantId])).rows[0];
    if (job && tenant && f.scheduledAt) {
      const end = f.endsAt ?? new Date(new Date(f.scheduledAt).getTime() + 2 * 3600_000).toISOString();
      const parsed = parseTenantNotice({ tenantName: str(tenant["display_name"]), tenantEmail: str(tenant["email"]), startsAt: f.scheduledAt, endsAt: end }, "1970-01-01T00:00:00Z");
      if (parsed.ok) await sendTenantNotice(db, job, parsed.value);
    }
  } catch { /* nothing identifying is logged */ }
}

/** Photos: the tenant, the owner, and the contractor on the job once they have accepted it. Anyone else gets undefined. */
export const PHOTO_SQL =
  "SELECT p.mime, p.bytes FROM rental_repair_photo p JOIN rental_repair r ON r.id = p.repair_id LEFT JOIN job_assignment a ON a.id = r.assignment_id " +
  "WHERE p.id = $1::uuid AND r.id = $2::uuid AND (r.tenant_user_id = $3::uuid OR r.owner_user_id = $3::uuid OR (a.contractor_user_id = $3::uuid AND a.status IN ('approved','completed')))";
export async function getRepairPhoto(db: Queryable, userId: string, repairId: string, photoId: string): Promise<{ mime: string; bytes: Buffer } | undefined> {
  if (!UUID.test(repairId) || !UUID.test(photoId)) return undefined;
  const r = (await db.query(PHOTO_SQL, [photoId, repairId, userId])).rows[0];
  return r ? { mime: str(r["mime"]), bytes: Buffer.from(r["bytes"] as Buffer) } : undefined;
}

// ---- Reading: the owner's desk and the tenant's page ------------------------------------------------------------------------------

export interface DeskApplication extends ApplicationRow { rank: number; evaluation: Evaluation; viewing?: { startsAt: string; status: string } }
export interface MessageView { id: string; kind: string; body: string; status: string; reason?: string; at: string }
export interface DeskRepair extends RepairRow { photoIds: string[]; messages: MessageView[]; assignmentStatus: string; visitAt?: string }
export interface Desk {
  listing: { id: string; address: string; weeklyRentCents?: number; published: boolean }; settings: RentalSettings; applications: DeskApplication[]; slots: SlotView[];
  tenancies: { id: string; tenantName: string; status: string }[]; repairs: DeskRepair[]
}
const MESSAGES_SQL = "SELECT subject_id, id, kind, body, status, reason, created_at FROM rental_message WHERE subject_id = ANY($1::uuid[]) AND to_user_id = $2::uuid ORDER BY created_at DESC LIMIT 200";
const VIEWINGS_SQL =
  "SELECT v.application_id, v.status, s.starts_at FROM rental_viewing v JOIN rental_viewing_slot s ON s.id = v.slot_id WHERE v.application_id = ANY($1::uuid[]) AND v.status IN ('booked','attended','no_show') ORDER BY v.created_at DESC";

async function messagesBySubject(db: Queryable, ids: string[], toUser: string): Promise<Map<string, MessageView[]>> {
  const map = new Map<string, MessageView[]>();
  if (ids.length === 0) return map;
  for (const r of (await db.query(MESSAGES_SQL, [ids, toUser])).rows) {
    const k = str(r["subject_id"]);
    map.set(k, [...(map.get(k) ?? []), { id: str(r["id"]), kind: str(r["kind"]), body: str(r["body"]), status: str(r["status"]), ...(r["reason"] ? { reason: str(r["reason"]) } : {}), at: iso(r["created_at"]) }]);
  }
  return map;
}

/** The owner sees "Applicant N" and no free-text note until they shortlist the applicant. The scored facts are all they need to compare. */
function hideIdentity(a: ApplicationRow): ApplicationRow {
  if (IDENTITY_STATUSES.includes(a.status)) return a;
  const { note: _note, ...rest } = a;
  return { ...rest, applicantName: `Applicant ${a.applicantNo}`, identityHidden: true };
}

export async function deskFor(db: Queryable, ownerId: string, listingId: string): Promise<Desk | undefined> {
  const l = await ownRent(db, ownerId, listingId);
  if (!l) return undefined;
  const settings = await getSettings(db, listingId);
  const apps = (await db.query(APPS_FOR_LISTING_SQL, [listingId])).rows.map(toApp);
  const evals = new Map(apps.map(a => [a.id, evaluate(a, settings, l.weeklyRentCents)]));
  const ranks = new Map(rankApplications(apps.map(a => ({ id: a.id, createdAt: a.createdAt, evaluation: evals.get(a.id)! }))).map(r => [r.id, r.rank]));
  const viewings = new Map<string, { startsAt: string; status: string }>();
  for (const v of apps.length ? (await db.query(VIEWINGS_SQL, [apps.map(a => a.id)])).rows : []) if (!viewings.has(str(v["application_id"]))) viewings.set(str(v["application_id"]), { startsAt: iso(v["starts_at"]), status: str(v["status"]) });
  const repairs = (await db.query(REPAIRS_FOR_LISTING_SQL, [listingId])).rows.map(toRepair);
  const photos = repairs.length ? (await db.query(PHOTOS_SQL, [repairs.map(r => r.id)])).rows : [];
  const repairMsgs = await messagesBySubject(db, repairs.map(r => r.id), ownerId);
  const facts = new Map<string, VisitFacts>();
  for (const r of repairs) if (r.assignmentId) facts.set(r.id, await visitFacts(db, r.assignmentId));
  const tenancies = (await db.query("SELECT t.id, t.status, u.display_name FROM rental_tenancy t JOIN app_user u ON u.id = t.tenant_user_id WHERE t.listing_id = $1::uuid ORDER BY t.created_at", [listingId])).rows;
  return {
    listing: { id: l.id, address: l.address, ...(l.weeklyRentCents ? { weeklyRentCents: l.weeklyRentCents } : {}), published: l.status === "published" }, settings,
    applications: apps.map(a => hideIdentity(a)).map(a => ({ ...a, rank: ranks.get(a.id)!, evaluation: evals.get(a.id)!, ...(viewings.has(a.id) ? { viewing: viewings.get(a.id)! } : {}) })).sort((a, b) => a.rank - b.rank),
    slots: await slotsFor(db, listingId),
    tenancies: tenancies.map(t => ({ id: str(t["id"]), tenantName: str(t["display_name"]), status: str(t["status"]) })),
    repairs: repairs.map(r => ({ ...r, photoIds: photos.filter(p => str(p["repair_id"]) === r.id).map(p => str(p["id"])), messages: repairMsgs.get(r.id) ?? [], assignmentStatus: facts.get(r.id)?.status ?? "none", ...(facts.get(r.id)?.scheduledAt ? { visitAt: facts.get(r.id)!.scheduledAt! } : {}) }))
  };
}

export interface MyRentals {
  applications: { id: string; listingId: string; address: string; weeklyRentCents?: number; status: string; evaluationMissing: CriterionKey[]; viewing?: { startsAt: string }; offers: SlotView[]; messages: MessageView[]; updatedAt: string }[];
  tenancies: { id: string; listingId: string; address: string }[];
  repairs: { id: string; ref: string; address: string; category: RepairCategory; description: string; urgency: Urgency; status: RepairStatus; createdAt: string; photoIds: string[]; visitAt?: string; needsConsent: boolean; messages: MessageView[] }[];
}
export const MY_APPS_SQL = "SELECT a.id FROM rental_application a WHERE a.applicant_user_id = $1::uuid AND a.status <> 'withdrawn' ORDER BY a.updated_at DESC LIMIT 50";
export async function myRentals(db: Queryable, userId: string, now: string): Promise<MyRentals> {
  const apps: MyRentals["applications"] = [];
  for (const row of (await db.query(MY_APPS_SQL, [userId])).rows) {
    const a = toApp((await db.query(APP_BY_ID_SQL, [str(row["id"])])).rows[0]!);
    const l = (await rentListing(db, a.listingId))!;
    const ev = evaluate(a, await getSettings(db, a.listingId), l.weeklyRentCents);
    const v = (await db.query(VIEWINGS_SQL, [[a.id]])).rows.find(x => x["status"] === "booked");
    const open = ["submitted", "info_requested", "shortlisted", "approved"].includes(a.status);
    apps.push({
      id: a.id, listingId: a.listingId, address: await addressForApplicant(db, a.id, userId, l.address), ...(l.weeklyRentCents ? { weeklyRentCents: l.weeklyRentCents } : {}), status: a.status, evaluationMissing: ev.missing,
      ...(v ? { viewing: { startsAt: iso(v["starts_at"]) } } : {}), offers: open ? pickOffers(await slotsFor(db, a.listingId), now, 6) : [], messages: (await messagesBySubject(db, [a.id], userId)).get(a.id) ?? [], updatedAt: a.updatedAt
    });
  }
  const tenancies = (await db.query("SELECT t.id, t.listing_id, l.address_text FROM rental_tenancy t JOIN property_listing l ON l.id = t.listing_id WHERE t.tenant_user_id = $1::uuid AND t.status = 'active' ORDER BY t.created_at", [userId])).rows
    .map(t => ({ id: str(t["id"]), listingId: str(t["listing_id"]), address: str(t["address_text"]) }));
  const reps = (await db.query(REPAIRS_FOR_TENANT_SQL, [userId])).rows.map(toRepair);
  const photos = reps.length ? (await db.query(PHOTOS_SQL, [reps.map(r => r.id)])).rows : [];
  const msgs = await messagesBySubject(db, reps.map(r => r.id), userId);
  const repairs: MyRentals["repairs"] = [];
  for (const r of reps) {
    const f = r.assignmentId ? await visitFacts(db, r.assignmentId) : undefined;
    repairs.push({
      id: r.id, ref: refOf(r.no), address: r.address, category: r.category, description: r.description, urgency: r.urgency, status: r.status, createdAt: r.createdAt,
      photoIds: photos.filter(p => str(p["repair_id"]) === r.id).map(p => str(p["id"])), ...(f?.scheduledAt ? { visitAt: f.scheduledAt } : {}),
      needsConsent: r.status === "scheduled" && !r.noticeSentAt && !r.tenantConsentAt && !!f?.scheduledAt && needsTenantConsent(f.scheduledAt, now, r.urgency === "emergency"), messages: msgs.get(r.id) ?? []
    });
  }
  return { applications: apps, tenancies, repairs };
}

// ---- The scheduler tick ---------------------------------------------------------------------------------------------------------

export interface RentalTick { repairs: number; reminders: number; summaries: number }

export const CLAIM_REPAIRS_SQL =
  "UPDATE rental_repair SET next_action_at = $1::timestamptz + interval '10 minutes' WHERE id IN (" +
  "SELECT r.id FROM rental_repair r JOIN rental_settings s ON s.listing_id = r.listing_id AND s.elena_on WHERE r.status NOT IN ('closed','needs_owner') AND r.next_action_at <= $1::timestamptz " +
  "ORDER BY r.next_action_at LIMIT 25 FOR UPDATE OF r SKIP LOCKED) RETURNING id";
const EMERGENCY_STATE_SQL =
  "SELECT CASE WHEN status = 'open' AND created_at <= now() - interval '6 hours' THEN 'expired' ELSE status END AS status, created_at FROM emergency_request WHERE id = $1::uuid";
const EMERGENCY_ACCEPT_SQL =
  "SELECT c.eta_minutes FROM emergency_request_contact c WHERE c.request_id = $1::uuid AND c.status = 'accepted' LIMIT 1";

async function repairContext(db: Queryable, r: RepairRow, now: string): Promise<RepairContext> {
  const f = await visitFacts(db, r.assignmentId);
  const ctx: RepairContext = { assignmentStatus: f.status, ...(f.scheduledAt ? { scheduledAt: f.scheduledAt } : {}), ...(r.offeredAt ? { offeredAt: r.offeredAt } : {}) };
  if (r.emergencyRequestId) {
    const e = (await db.query(EMERGENCY_STATE_SQL, [r.emergencyRequestId])).rows[0];
    if (e) {
      const quiet = (await db.query("SELECT 1 FROM rental_message WHERE subject_id = $1::uuid AND kind = 'repair_emergency_quiet' AND status = 'sent' LIMIT 1", [r.id])).rows.length > 0;
      ctx.emergency = { status: str(e["status"]) as "open" | "accepted" | "cancelled" | "expired", ageMinutes: Math.floor((Date.parse(now) - Date.parse(iso(e["created_at"]))) / 60_000), quietNotified: quiet };
    }
  }
  return ctx;
}

export async function applyRepairSteps(db: Queryable, sender: RentalSender, repair: RepairRow, steps: readonly RepairStep[], now: string): Promise<void> {
  const l = (await rentListing(db, repair.listingId))!;
  const v: RentalVars = { address: l.address, ref: refOf(repair.no), category: REPAIR_LABELS[repair.category], urgency: repair.urgency };
  let status = repair.status;
  for (const s of steps) {
    if (s.type === "set") {
      const p = s.patch;
      if (p.status) status = p.status;
      await db.query(
        "UPDATE rental_repair SET status = COALESCE($2::text, status), chases = COALESCE($3::integer, chases), next_action_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE next_action_at END, " +
        "needs_owner_reason = CASE WHEN $2::text = 'needs_owner' THEN $6::text ELSE needs_owner_reason END, " +
        "proposed_contractor_id = CASE WHEN $7::boolean THEN NULL ELSE proposed_contractor_id END, assignment_id = CASE WHEN $7::boolean THEN NULL ELSE assignment_id END, notice_sent_at = CASE WHEN $7::boolean THEN NULL ELSE notice_sent_at END, updated_at = now() WHERE id = $1::uuid",
        [repair.id, p.status ?? null, p.chases ?? null, p.nextActionAt !== undefined, p.nextActionAt ?? null, p.reason ?? null, p.reopenProposal === true]);
    } else {
      const to = s.to === "owner" ? repair.ownerId : repair.tenantId;
      const vars: RentalVars = { ...v, ...(s.vars?.when ? { when: formatAppointment(s.vars.when, l.jurisdiction) } : {}), ...(s.vars?.reason ? { reason: s.vars.reason } : {}) };
      let extra: Partial<RentalVars> = {};
      if (s.kind === "repair_contractor_declined") extra = { contractor: first(repair.proposedContractorName ?? "The contractor") };
      if (s.kind === "repair_emergency_accepted" && repair.emergencyRequestId) {
        const eta = (await db.query(EMERGENCY_ACCEPT_SQL, [repair.emergencyRequestId])).rows[0]?.["eta_minutes"];
        if (eta !== null && eta !== undefined) extra = { eta: `${Number(eta)} minutes` };
      }
      await say(db, sender, { listingId: repair.listingId, subjectType: "repair", subjectId: repair.id, to, kind: s.kind, vars: { ...vars, ...extra }, link: s.to === "owner" ? ownerLink(repair.listingId) : "/rentals", now, address: l.address });
    }
  }
  if (status === "scheduled" && repair.status !== "scheduled") await sendVisitNotice(db, sender, (await getRepair(db, repair.id))!, now);
}

export async function runDueRentals(db: Queryable, now: string, sender: RentalSender = createRentalSender(db), env: Env = process.env): Promise<RentalTick> {
  const out: RentalTick = { repairs: 0, reminders: 0, summaries: 0 };
  // Repairs for listings where the owner switched Elena on.
  for (const row of (await db.query(CLAIM_REPAIRS_SQL, [now])).rows) {
    try {
      const repair = await getRepair(db, str(row["id"]));
      if (!repair) continue;
      const steps = repairDue({ id: repair.id, status: repair.status, urgency: repair.urgency, chases: repair.chases }, await repairContext(db, repair, now), now);
      // A decline by the contractor re-proposes the next suggestion for the owner to approve.
      await applyRepairSteps(db, sender, repair, steps, now);
      if (steps.some(s => s.type === "set" && s.patch.reopenProposal)) {
        const fresh = (await getRepair(db, repair.id))!;
        await proposeAndMaybeOffer(db, sender, env, { ...fresh, askedContractorIds: repair.askedContractorIds }, { ...(await getSettings(db, repair.listingId)), autoRepairOffers: false }, now);
      }
      out.repairs++;
    } catch { /* one repair never stops the rest */ }
  }
  out.reminders = await runViewingReminders(db, sender, now);
  out.summaries = await runViewingSummaries(db, sender, now);
  return out;
}

export const REMINDERS_SQL =
  "SELECT v.id, v.application_id, a.applicant_user_id, a.listing_id, s.starts_at, v.reminder_24h_at, v.reminder_2h_at FROM rental_viewing v JOIN rental_viewing_slot s ON s.id = v.slot_id " +
  "JOIN rental_application a ON a.id = v.application_id JOIN rental_settings st ON st.listing_id = a.listing_id AND st.elena_on " +
  "WHERE v.status = 'booked' AND s.status = 'open' AND s.starts_at > $1::timestamptz AND s.starts_at <= $1::timestamptz + interval '24 hours' AND (v.reminder_24h_at IS NULL OR v.reminder_2h_at IS NULL) LIMIT 100";
export const CLAIM_24H_SQL = "UPDATE rental_viewing SET reminder_24h_at = $2::timestamptz WHERE id = $1::uuid AND reminder_24h_at IS NULL RETURNING id";
export const CLAIM_2H_SQL = "UPDATE rental_viewing SET reminder_2h_at = $2::timestamptz, reminder_24h_at = COALESCE(reminder_24h_at, $2::timestamptz) WHERE id = $1::uuid AND reminder_2h_at IS NULL RETURNING id";
async function runViewingReminders(db: Queryable, sender: RentalSender, now: string): Promise<number> {
  let n = 0;
  for (const r of (await db.query(REMINDERS_SQL, [now])).rows) {
    const start = Date.parse(iso(r["starts_at"])), hours = (start - Date.parse(now)) / 3600_000;
    const l = (await rentListing(db, str(r["listing_id"])))!;
    const when = formatAppointment(iso(r["starts_at"]), l.jurisdiction);
    const kind = hours <= 2 ? "viewing_reminder_2h" : "viewing_reminder_24h";
    if ((await db.query(kind === "viewing_reminder_2h" ? CLAIM_2H_SQL : CLAIM_24H_SQL, [str(r["id"]), now])).rows.length === 0) continue;
    await say(db, sender, { listingId: l.id, subjectType: "viewing", subjectId: str(r["application_id"]), to: str(r["applicant_user_id"]), kind, vars: { address: l.address, when: hours <= 2 ? when : `tomorrow, ${when}` }, link: "/rentals", now, address: l.address });
    n++;
  }
  return n;
}

export const SUMMARY_SLOTS_SQL =
  "SELECT s.id, s.listing_id, s.starts_at FROM rental_viewing_slot s JOIN rental_settings st ON st.listing_id = s.listing_id AND st.elena_on " +
  "WHERE s.status = 'open' AND s.summary_sent_at IS NULL AND s.starts_at + (s.duration_min || ' minutes')::interval <= $1::timestamptz AND s.starts_at > $1::timestamptz - interval '3 days' LIMIT 50";
export const CLAIM_SUMMARY_SQL = "UPDATE rental_viewing_slot SET summary_sent_at = $2::timestamptz WHERE id = $1::uuid AND summary_sent_at IS NULL RETURNING id";
export const SLOT_GUESTS_SQL = "SELECT a.id, u.display_name FROM rental_viewing v JOIN rental_application a ON a.id = v.application_id JOIN app_user u ON u.id = a.applicant_user_id WHERE v.slot_id = $1::uuid AND v.status IN ('booked','attended','no_show') ORDER BY v.created_at";
/** After a viewing slot has finished, the owner gets one summary of who was booked, with where each applicant sits in the comparison. */
async function runViewingSummaries(db: Queryable, sender: RentalSender, now: string): Promise<number> {
  let n = 0;
  for (const s of (await db.query(SUMMARY_SLOTS_SQL, [now])).rows) {
    if ((await db.query(CLAIM_SUMMARY_SQL, [str(s["id"]), now])).rows.length === 0) continue;
    const guests = (await db.query(SLOT_GUESTS_SQL, [str(s["id"])])).rows;
    if (guests.length === 0) continue;
    const l = (await rentListing(db, str(s["listing_id"])))!;
    const desk = await deskFor(db, l.ownerId, l.id);
    const list = (await Promise.all(guests.map(async g => `${await ownerLabel(db, str(g["id"]))}${desk ? ` (comparison position ${desk.applications.find(a => a.id === str(g["id"]))?.rank ?? "n/a"} of ${desk.applications.length})` : ""}`))).join(", ");
    await say(db, sender, { listingId: l.id, subjectType: "viewing", subjectId: str(s["id"]), to: l.ownerId, kind: "viewing_summary", vars: { address: l.address, when: formatAppointment(iso(s["starts_at"]), l.jurisdiction), count: guests.length, list }, link: ownerLink(l.id), now, address: l.address });
    n++;
  }
  return n;
}
