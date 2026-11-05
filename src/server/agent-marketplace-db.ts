import { randomUUID } from "node:crypto";
import {
  MAX_PORTFOLIO_ITEMS, PAGE_SIZE, generateSlots, parseBooking, parsePortfolioItem, parseReview, ratingSummary, shortName,
  type BrowseQuery, type MarketplaceProfile, type Slot, type Window
} from "../domain/agent-marketplace";
import type { Actor, Failure, Result } from "../domain/listing-service";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";
import { notifyUser } from "./notifier";

// Constant SQL text; user input only travels as bound parameters. Agent and client ids always come from the session.

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
const audit = (db: Queryable, actorId: string, type: string, id: string, event: string, now: string, payload: Record<string, unknown> = {}) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId, aggregateType: type, aggregateId: id, eventType: event, correlationId: randomUUID(), payload });

const VERIFIED_LICENCE = "EXISTS (SELECT 1 FROM agent_licence l WHERE l.user_id = u.id AND l.status = 'verified')";
/** Platform sales: listings the agent was appointed to that have an accepted offer. Only counts, suburb and month are ever shown, never the price. */
const PLATFORM_SALES = "(SELECT count(DISTINCT o.listing_id) FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id AND o.status = 'accepted' WHERE a.agent_user_id = u.id)";

const CARD_COLUMNS =
  `u.id, u.display_name, p.headline, p.photo_url, p.specialties, p.languages, p.years_experience, p.consult_modes, p.consult_minutes, p.service_suburbs, p.accepting_new,
   COALESCE(r.n, 0) AS review_count, r.avg AS rating, (${PLATFORM_SALES} + (SELECT count(*) FROM agent_portfolio_item i WHERE i.agent_user_id = u.id)) AS sales`;
const RATING_JOIN = "LEFT JOIN (SELECT agent_user_id, count(*) AS n, avg(rating) AS avg FROM agent_review WHERE status = 'published' GROUP BY agent_user_id) r ON r.agent_user_id = u.id";
const ORDER: Record<BrowseQuery["sort"], string> = {
  rating: "COALESCE(r.avg, 0) DESC, COALESCE(r.n, 0) DESC, u.display_name, u.id",
  reviews: "COALESCE(r.n, 0) DESC, COALESCE(r.avg, 0) DESC, u.display_name, u.id",
  experience: "p.years_experience DESC NULLS LAST, u.display_name, u.id",
  name: "u.display_name, u.id"
};
// Optional filters: an empty parameter switches its clause off. strpos avoids LIKE wildcards in user text.
const BROWSE_WHERE =
  `p.listed AND u.status = 'active' AND u.user_type = 'agent' AND ${VERIFIED_LICENCE}
   AND ($1::text = '' OR strpos(lower(u.display_name || ' ' || p.headline), lower($1::text)) > 0)
   AND ($2::text = '' OR $2::text = ANY(p.service_postcodes) OR EXISTS (SELECT 1 FROM unnest(p.service_suburbs) s WHERE strpos(lower(s), lower($2::text)) > 0))
   AND ($3::text = '' OR $3::text = ANY(p.specialties))
   AND ($4::text = '' OR $4::text = ANY(p.languages))
   AND ($5::text = '' OR $5::text = ANY(p.consult_modes))
   AND COALESCE(r.avg, 0) >= $6::numeric`;

export interface AgentCard {
  id: string; name: string; headline: string; photoUrl: string | null; specialties: string[]; languages: string[]; yearsExperience: number | null;
  consultModes: string[]; consultMinutes: number; areas: string[]; acceptingNew: boolean; reviewCount: number; rating: number | null; sales: number;
}
const toCard = (r: Record<string, unknown>): AgentCard => ({
  id: String(r["id"]), name: String(r["display_name"]), headline: String(r["headline"] ?? ""), photoUrl: r["photo_url"] ? String(r["photo_url"]) : null,
  specialties: list(r["specialties"]), languages: list(r["languages"]), yearsExperience: r["years_experience"] === null ? null : Number(r["years_experience"]),
  consultModes: list(r["consult_modes"]), consultMinutes: Number(r["consult_minutes"]), areas: list(r["service_suburbs"]).slice(0, 6), acceptingNew: r["accepting_new"] === true,
  reviewCount: Number(r["review_count"]), rating: r["rating"] === null || r["rating"] === undefined ? null : Math.round(Number(r["rating"]) * 10) / 10, sales: Number(r["sales"])
});

export async function browseAgents(db: Queryable, q: BrowseQuery): Promise<{ agents: AgentCard[]; total: number; page: number; pageSize: number }> {
  const args = [q.q, q.area, q.specialty, q.language, q.mode, q.minRating];
  const [rows, total] = await Promise.all([
    db.query(`SELECT ${CARD_COLUMNS} FROM agent_profile p JOIN app_user u ON u.id = p.user_id ${RATING_JOIN} WHERE ${BROWSE_WHERE} ORDER BY ${ORDER[q.sort]} LIMIT ${PAGE_SIZE} OFFSET $7::int`, [...args, (q.page - 1) * PAGE_SIZE]),
    db.query(`SELECT count(*) AS n FROM agent_profile p JOIN app_user u ON u.id = p.user_id ${RATING_JOIN} WHERE ${BROWSE_WHERE}`, args)
  ]);
  return { agents: rows.rows.map(toCard), total: Number(total.rows[0]?.["n"] ?? 0), page: q.page, pageSize: PAGE_SIZE };
}

export interface PortfolioEntry { source: "platform" | "agent"; suburb: string; propertyType: string; month: string; priceCents?: number; note?: string; id?: string }

async function portfolioFor(db: Queryable, agentId: string, limit: number): Promise<PortfolioEntry[]> {
  const [platform, own] = await Promise.all([
    db.query(
      `SELECT l.suburb, l.property_type, to_char(max(o.submitted_at), 'YYYY-MM') AS month
         FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id AND o.status = 'accepted' JOIN property_listing l ON l.id = a.listing_id
        WHERE a.agent_user_id = $1::uuid GROUP BY l.id, l.suburb, l.property_type ORDER BY max(o.submitted_at) DESC LIMIT $2::int`, [agentId, limit]),
    db.query("SELECT id, suburb, property_type, to_char(sold_on, 'YYYY-MM') AS month, price_cents, note FROM agent_portfolio_item WHERE agent_user_id = $1::uuid ORDER BY sold_on DESC LIMIT $2::int", [agentId, limit])
  ]);
  const a = platform.rows.map((r): PortfolioEntry => ({ source: "platform", suburb: String(r["suburb"] ?? "Suburb not shown"), propertyType: String(r["property_type"]), month: String(r["month"]) }));
  const b = own.rows.map((r): PortfolioEntry => ({
    source: "agent", id: String(r["id"]), suburb: String(r["suburb"]), propertyType: String(r["property_type"]), month: String(r["month"]), note: String(r["note"] ?? ""),
    ...(r["price_cents"] !== null ? { priceCents: Number(r["price_cents"]) } : {})
  }));
  return [...a, ...b].sort((x, y) => y.month.localeCompare(x.month)).slice(0, limit);
}

export async function getPublicProfile(db: Queryable, agentId: string) {
  const r = (await db.query(
    `SELECT ${CARD_COLUMNS}, p.bio, p.service_postcodes, p.video_url IS NOT NULL AS has_video, p.timezone
       FROM agent_profile p JOIN app_user u ON u.id = p.user_id ${RATING_JOIN} WHERE u.id = $1::uuid AND p.listed AND u.status = 'active' AND u.user_type = 'agent' AND ${VERIFIED_LICENCE}`, [agentId])).rows[0];
  if (!r) return undefined;
  const [reviews, ratings, portfolio] = await Promise.all([
    db.query("SELECT v.rating, v.title, v.body, v.created_at, u.display_name FROM agent_review v JOIN app_user u ON u.id = v.reviewer_user_id WHERE v.agent_user_id = $1::uuid AND v.status = 'published' ORDER BY v.created_at DESC LIMIT 20", [agentId]),
    db.query("SELECT rating FROM agent_review WHERE agent_user_id = $1::uuid AND status = 'published'", [agentId]),
    portfolioFor(db, agentId, 12)
  ]);
  return {
    ...toCard(r), bio: String(r["bio"] ?? ""), postcodes: list(r["service_postcodes"]), timezone: String(r["timezone"]),
    ratings: ratingSummary(ratings.rows.map(x => Number(x["rating"]))),
    reviews: reviews.rows.map(x => ({ rating: Number(x["rating"]), title: String(x["title"]), body: String(x["body"]), createdAt: new Date(String(x["created_at"])).toISOString(), reviewer: shortName(String(x["display_name"])) })),
    portfolio
  };
}

// ---- Agent: manage own listing -------------------------------------------------------------------------------------------------------

const isAgent = (a: Actor) => a.userType === "agent";

export async function getOwnMarketplace(db: Queryable, actor: Actor): Promise<Result<{ profile: MarketplaceProfile; bio: string; portfolio: PortfolioEntry[]; maxPortfolio: number }>> {
  if (!isAgent(actor)) return fail("forbidden", "Only agents have a marketplace profile.");
  const [p, av] = await Promise.all([
    db.query("SELECT bio, listed, headline, photo_url, specialties, languages, years_experience, consult_modes, consult_minutes, video_url, timezone FROM agent_profile WHERE user_id = $1::uuid", [actor.userId]),
    db.query("SELECT weekday, start_min, end_min FROM agent_availability WHERE agent_user_id = $1::uuid ORDER BY weekday, start_min", [actor.userId])
  ]);
  const r = p.rows[0] ?? {};
  return { ok: true, value: {
    bio: String(r["bio"] ?? ""), maxPortfolio: MAX_PORTFOLIO_ITEMS, portfolio: (await portfolioFor(db, actor.userId, MAX_PORTFOLIO_ITEMS)).filter(x => x.source === "agent"),
    profile: {
      listed: r["listed"] === true, headline: String(r["headline"] ?? ""), photoUrl: r["photo_url"] ? String(r["photo_url"]) : null, specialties: list(r["specialties"]), languages: list(r["languages"]),
      yearsExperience: r["years_experience"] === null || r["years_experience"] === undefined ? null : Number(r["years_experience"]), consultModes: list(r["consult_modes"]) as MarketplaceProfile["consultModes"],
      consultMinutes: Number(r["consult_minutes"] ?? 30), videoUrl: r["video_url"] ? String(r["video_url"]) : null, timezone: String(r["timezone"] ?? "Australia/Brisbane"),
      availability: av.rows.map((x): Window => ({ weekday: Number(x["weekday"]), startMin: Number(x["start_min"]), endMin: Number(x["end_min"]) }))
    }
  } };
}

/** Saves the marketplace fields and weekly hours. Going public needs a verified licence for any state, a headline and a bio of at least 20 characters. */
export async function saveOwnMarketplace(db: Queryable, actor: Actor, p: MarketplaceProfile, now: string): Promise<Result<{ saved: true }>> {
  if (!isAgent(actor)) return fail("forbidden", "Only agents have a marketplace profile.");
  if (p.listed) {
    const ok = (await db.query("SELECT (SELECT length(btrim(bio)) FROM agent_profile WHERE user_id = $1::uuid) AS bio_len, EXISTS (SELECT 1 FROM agent_licence WHERE user_id = $1::uuid AND status = 'verified') AS licensed", [actor.userId])).rows[0];
    if (!ok?.["licensed"]) return fail("forbidden", "Only agents with a verified licence can be listed.");
    if (!p.headline) return fail("invalid", "Add a headline before you go public.");
    if (Number(ok["bio_len"] ?? 0) < 20) return fail("invalid", "Write a bio of at least 20 characters (on your agent profile) before you go public.");
    if (p.consultModes.length > 0 && p.availability.length === 0) return fail("invalid", "Add your weekly hours so buyers can book.");
  }
  await atomic(db, async tx => {
    await tx.query("INSERT INTO agent_profile (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING", [actor.userId]);
    await tx.query(
      `UPDATE agent_profile SET listed = $2, headline = $3, photo_url = $4, specialties = $5::text[], languages = $6::text[], years_experience = $7, consult_modes = $8::text[],
              consult_minutes = $9, video_url = $10, timezone = $11, updated_at = $12::timestamptz WHERE user_id = $1::uuid`,
      [actor.userId, p.listed, p.headline, p.photoUrl, p.specialties, p.languages, p.yearsExperience, p.consultModes, p.consultMinutes, p.videoUrl, p.timezone, now]);
    await tx.query("DELETE FROM agent_availability WHERE agent_user_id = $1::uuid", [actor.userId]);
    for (const w of p.availability) await tx.query("INSERT INTO agent_availability (agent_user_id, weekday, start_min, end_min) VALUES ($1::uuid,$2,$3,$4)", [actor.userId, w.weekday, w.startMin, w.endMin]);
    await audit(tx, actor.userId, "agent_marketplace", actor.userId, p.listed ? "marketplace.listed" : "marketplace.unlisted", now);
  });
  return { ok: true, value: { saved: true } };
}

export async function addPortfolioItem(db: Queryable, actor: Actor, body: unknown, now: string): Promise<Result<{ id: string }>> {
  if (!isAgent(actor)) return fail("forbidden", "Only agents have a portfolio.");
  const v = parsePortfolioItem(body, now);
  if (!v.ok) return v;
  const n = Number((await db.query("SELECT count(*) AS n FROM agent_portfolio_item WHERE agent_user_id = $1::uuid", [actor.userId])).rows[0]?.["n"] ?? 0);
  if (n >= MAX_PORTFOLIO_ITEMS) return fail("conflict", `A portfolio holds up to ${MAX_PORTFOLIO_ITEMS} sales. Remove one first.`);
  const id = String((await db.query(
    "INSERT INTO agent_portfolio_item (agent_user_id, suburb, property_type, sold_on, price_cents, note) VALUES ($1::uuid,$2,$3,$4::date,$5,$6) RETURNING id",
    [actor.userId, v.value.suburb, v.value.propertyType, v.value.soldOn, v.value.priceCents, v.value.note])).rows[0]!["id"]);
  return { ok: true, value: { id } };
}

export async function removePortfolioItem(db: Queryable, actor: Actor, itemId: string): Promise<Result<{ removed: true }>> {
  if (!isAgent(actor)) return fail("forbidden", "Only agents have a portfolio.");
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return fail("not_found", "Sale not found.");
  const r = await db.query("DELETE FROM agent_portfolio_item WHERE id = $1::uuid AND agent_user_id = $2::uuid RETURNING id", [itemId, actor.userId]);
  return r.rows.length > 0 ? { ok: true, value: { removed: true } } : fail("not_found", "Sale not found.");
}

// ---- Booking ------------------------------------------------------------------------------------------------------------------

const BOOKABLE_SQL =
  `SELECT p.consult_modes, p.consult_minutes, p.timezone, u.display_name FROM agent_profile p JOIN app_user u ON u.id = p.user_id
    WHERE u.id = $1::uuid AND p.listed AND u.status = 'active' AND u.user_type = 'agent' AND ${VERIFIED_LICENCE}`;

async function openSlots(db: Queryable, agentId: string, now: string): Promise<{ slots: Slot[]; modes: string[]; minutes: number; timezone: string; name: string } | undefined> {
  const a = (await db.query(BOOKABLE_SQL, [agentId])).rows[0];
  if (!a) return undefined;
  const [av, busy] = await Promise.all([
    db.query("SELECT weekday, start_min, end_min FROM agent_availability WHERE agent_user_id = $1::uuid", [agentId]),
    db.query("SELECT starts_at, ends_at FROM agent_consultation WHERE agent_user_id = $1::uuid AND status = 'confirmed' AND ends_at > $2::timestamptz", [agentId, now])
  ]);
  const minutes = Number(a["consult_minutes"]), timezone = String(a["timezone"]);
  const slots = generateSlots(av.rows.map(x => ({ weekday: Number(x["weekday"]), startMin: Number(x["start_min"]), endMin: Number(x["end_min"]) })), timezone, minutes,
    busy.rows.map(x => ({ startsAt: new Date(String(x["starts_at"])).toISOString(), endsAt: new Date(String(x["ends_at"])).toISOString() })), now);
  return { slots, modes: list(a["consult_modes"]), minutes, timezone, name: String(a["display_name"]) };
}

export async function getSlots(db: Queryable, agentId: string, now: string): Promise<Result<{ slots: Slot[]; modes: string[]; minutes: number; timezone: string }>> {
  const s = await openSlots(db, agentId, now);
  if (!s) return fail("not_found", "Agent not found.");
  return { ok: true, value: { slots: s.slots, modes: s.modes, minutes: s.minutes, timezone: s.timezone } };
}

const fmtWhen = (iso: string, tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));

/** Books a free slot. Only buyers and owners book; the slot must be one the agent really offers; the database refuses a double booking. */
export async function bookConsultation(db: Queryable, actor: Actor, agentId: string, body: unknown, now: string): Promise<Result<{ id: string; startsAt: string; endsAt: string }>> {
  if (actor.userType !== "buyer" && actor.userType !== "owner") return fail("forbidden", "Sign in as a buyer or owner to book a consultation.");
  const v = parseBooking(body);
  if (!v.ok) return v;
  const s = await openSlots(db, agentId, now);
  if (!s) return fail("not_found", "Agent not found.");
  if (!s.modes.includes(v.value.mode)) return fail("invalid", "This agent does not offer that consultation type.");
  const slot = s.slots.find(x => x.startsAt === v.value.startsAt);
  if (!slot) return fail("conflict", "That time is no longer available. Please pick another.");
  let id: string;
  try {
    id = await atomic(db, async tx => {
      const row = (await tx.query(
        "INSERT INTO agent_consultation (agent_user_id, client_user_id, starts_at, ends_at, mode, client_phone, note) VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5,$6,$7) RETURNING id",
        [agentId, actor.userId, slot.startsAt, slot.endsAt, v.value.mode, v.value.phone, v.value.note])).rows[0]!;
      await audit(tx, actor.userId, "agent_consultation", String(row["id"]), "consultation.booked", now, { agentId, mode: v.value.mode });
      return String(row["id"]);
    });
  } catch (e) {
    if (isUniqueViolation(e)) return fail("conflict", "That time was just taken. Please pick another.");
    throw e;
  }
  const when = fmtWhen(slot.startsAt, s.timezone);
  const client = String((await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [actor.userId])).rows[0]?.["display_name"] ?? "");
  await notifyUser(db, agentId, "consultation_booked", { name: client, when, link: "/agent/marketplace" });
  await notifyUser(db, actor.userId, "consultation_confirmed", { name: s.name, when, link: "/marketplace/consultations" });
  return { ok: true, value: { id, ...slot } };
}

export async function cancelConsultation(db: Queryable, actor: Actor, id: string, now: string): Promise<Result<{ cancelled: true }>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("not_found", "Consultation not found.");
  const c = (await db.query(
    `SELECT c.agent_user_id, c.client_user_id, c.starts_at, c.status, p.timezone FROM agent_consultation c JOIN agent_profile p ON p.user_id = c.agent_user_id
      WHERE c.id = $1::uuid AND (c.agent_user_id = $2::uuid OR c.client_user_id = $2::uuid)`, [id, actor.userId])).rows[0];
  if (!c) return fail("not_found", "Consultation not found.");
  const startsAt = new Date(String(c["starts_at"])).toISOString();
  if (c["status"] !== "confirmed") return fail("conflict", "That consultation is already cancelled.");
  if (startsAt <= now) return fail("conflict", "That consultation has already started.");
  await atomic(db, async tx => {
    await tx.query("UPDATE agent_consultation SET status = 'cancelled', cancelled_by = $2::uuid WHERE id = $1::uuid AND status = 'confirmed'", [id, actor.userId]);
    await audit(tx, actor.userId, "agent_consultation", id, "consultation.cancelled", now);
  });
  const other = String(c["agent_user_id"]) === actor.userId ? String(c["client_user_id"]) : String(c["agent_user_id"]);
  const me = String((await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [actor.userId])).rows[0]?.["display_name"] ?? "");
  await notifyUser(db, other, "consultation_cancelled", { name: me, when: fmtWhen(startsAt, String(c["timezone"])), link: String(c["agent_user_id"]) === actor.userId ? "/marketplace/consultations" : "/agent/marketplace" });
  return { ok: true, value: { cancelled: true } };
}

export interface ConsultationRow { id: string; role: "client" | "agent"; counterpart: string; agentId: string; startsAt: string; endsAt: string; mode: string; status: string; videoUrl?: string; phone?: string; note?: string; timezone: string }

/** Upcoming and recent consultations for the signed-in user, as client and (for agents) as host. A video link is only shown to the client of a confirmed booking. */
export async function listMyConsultations(db: Queryable, actor: Actor, now: string): Promise<ConsultationRow[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.agent_user_id, c.client_user_id, c.starts_at, c.ends_at, c.mode, c.status, c.client_phone, c.note, p.video_url, p.timezone, ag.display_name AS agent_name, cl.display_name AS client_name
       FROM agent_consultation c JOIN agent_profile p ON p.user_id = c.agent_user_id JOIN app_user ag ON ag.id = c.agent_user_id JOIN app_user cl ON cl.id = c.client_user_id
      WHERE (c.agent_user_id = $1::uuid OR c.client_user_id = $1::uuid) AND c.ends_at > $2::timestamptz - interval '30 days'
      ORDER BY c.starts_at DESC LIMIT 100`, [actor.userId, now]);
  return rows.map((r): ConsultationRow => {
    const asAgent = String(r["agent_user_id"]) === actor.userId;
    const live = r["status"] === "confirmed";
    return {
      id: String(r["id"]), role: asAgent ? "agent" : "client", agentId: String(r["agent_user_id"]), counterpart: String(asAgent ? r["client_name"] : r["agent_name"]),
      startsAt: new Date(String(r["starts_at"])).toISOString(), endsAt: new Date(String(r["ends_at"])).toISOString(), mode: String(r["mode"]), status: String(r["status"]), timezone: String(r["timezone"]),
      ...(!asAgent && live && r["mode"] === "video" && r["video_url"] ? { videoUrl: String(r["video_url"]) } : {}),
      ...(asAgent && live && r["client_phone"] ? { phone: String(r["client_phone"]) } : {}),
      ...(asAgent && r["note"] ? { note: String(r["note"]) } : {})
    };
  });
}

// ---- Reviews -------------------------------------------------------------------------------------------------------------------

const CAN_REVIEW =
  `EXISTS (SELECT 1 FROM agent_consultation c WHERE c.agent_user_id = $1::uuid AND c.client_user_id = $2::uuid AND c.status = 'confirmed' AND c.ends_at <= $3::timestamptz)
   OR EXISTS (SELECT 1 FROM listing_agent_appointment a JOIN enquiry e ON e.listing_id = a.listing_id WHERE a.agent_user_id = $1::uuid AND e.buyer_user_id = $2::uuid)
   OR EXISTS (SELECT 1 FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id WHERE a.agent_user_id = $1::uuid AND l.owner_user_id = $2::uuid)`;

export async function canReview(db: Queryable, actor: Actor | null, agentId: string, now: string): Promise<boolean> {
  if (!actor || actor.userId === agentId || (actor.userType !== "buyer" && actor.userType !== "owner")) return false;
  const r = (await db.query(`SELECT (${CAN_REVIEW}) AS ok, EXISTS (SELECT 1 FROM agent_review WHERE agent_user_id = $1::uuid AND reviewer_user_id = $2::uuid) AS done`, [agentId, actor.userId, now])).rows[0];
  return r?.["ok"] === true && r["done"] !== true;
}

export async function submitReview(db: Queryable, actor: Actor, agentId: string, body: unknown, now: string): Promise<Result<{ id: string }>> {
  if (actor.userType !== "buyer" && actor.userType !== "owner") return fail("forbidden", "Only buyers and owners can review an agent.");
  if (actor.userId === agentId) return fail("forbidden", "You cannot review yourself.");
  const v = parseReview(body);
  if (!v.ok) return v;
  if (!(await db.query("SELECT 1 FROM app_user u JOIN agent_profile p ON p.user_id = u.id WHERE u.id = $1::uuid AND u.user_type = 'agent' AND p.listed", [agentId])).rows[0]) return fail("not_found", "Agent not found.");
  if (!(await db.query(`SELECT 1 WHERE ${CAN_REVIEW}`, [agentId, actor.userId, now])).rows[0]) return fail("forbidden", "You can review an agent after a consultation with them, or after dealing with them on a listing.");
  let id: string;
  try {
    id = await atomic(db, async tx => {
      const row = (await tx.query("INSERT INTO agent_review (agent_user_id, reviewer_user_id, rating, title, body) VALUES ($1::uuid,$2::uuid,$3,$4,$5) RETURNING id", [agentId, actor.userId, v.value.rating, v.value.title, v.value.body])).rows[0]!;
      await audit(tx, actor.userId, "agent_review", String(row["id"]), "review.submitted", now, { agentId, rating: v.value.rating });
      return String(row["id"]);
    });
  } catch (e) {
    if (isUniqueViolation(e)) return fail("conflict", "You have already reviewed this agent.");
    throw e;
  }
  await notifyUser(db, agentId, "review_received", { name: "A client", link: `/marketplace/agents/${agentId}` });
  return { ok: true, value: { id } };
}

export const getMarketplaceDb = () => getDb();
export const marketplaceNow = () => new Date().toISOString();
