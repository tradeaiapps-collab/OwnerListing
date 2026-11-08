import { randomUUID } from "node:crypto";
import { ANALYTICS_TIME_ZONE } from "../domain/admin-analytics";
import { parseRating, type PerfAgent, type PerfFacts, type PerfOffer, type PerfRating } from "../domain/agent-performance";
import type { Actor, Failure, Result } from "../domain/listing-service";
import { appendAuditPg, type Queryable } from "./db";
import { notifyUser } from "./notifier";

// Constant SQL text; user input only travels as bound parameters. The buyer's id is used for the one-rating-per-sale rule and is never selected back.

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
const covers = (at: string) => `a.appointed_at <= ${at} AND (a.revoked_at IS NULL OR a.revoked_at > ${at})`;

/** Who owners can choose: the agent marketplace's listed agents (verified licence, active), or one agent for their own dashboard. */
const LISTED = `p.listed AND u.status = 'active' AND u.user_type = 'agent'
  AND EXISTS (SELECT 1 FROM agent_licence l WHERE l.user_id = u.id AND l.status = 'verified')`;

/**
 * Facts between `from` and `to` (inclusive calendar days in the reporting zone). `scope`: "listed" = marketplace agents, "all" = every agent
 * with an appointment (staff), or an agent id (their own figures only).
 */
export async function loadPerformanceFacts(db: Queryable, from: string, to: string, scope: "listed" | "all" | { agentId: string }): Promise<PerfFacts> {
  const only = typeof scope === "object" ? scope.agentId : null;
  const who = (col: string) => `($4::uuid IS NULL OR ${col} = $4::uuid)`;
  const params = [from, to, ANALYTICS_TIME_ZONE, only];
  const within = (col: string) => `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
  const listedOnly = scope === "listed";
  const listedAgent = (col: string) => `($5::boolean = false OR EXISTS (SELECT 1 FROM app_user u JOIN agent_profile p ON p.user_id = u.id WHERE u.id = ${col} AND ${LISTED}))`;

  const [agents, offers, ratings] = await Promise.all([
    db.query(
      `SELECT u.id, u.display_name, p.headline, p.specialties, p.service_suburbs, p.accepting_new,
              (SELECT count(*) FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id
                WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL AND l.status = 'published') AS active_listings
         FROM app_user u LEFT JOIN agent_profile p ON p.user_id = u.id
        WHERE u.user_type = 'agent' AND ${who("u.id")}
          AND ($5::boolean = false OR (${LISTED}))
          AND ($5::boolean = true OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.agent_user_id = u.id) OR $4::uuid IS NOT NULL)
          AND $1::date IS NOT NULL AND $2::date IS NOT NULL AND $3::text IS NOT NULL -- every query shares one parameter list; this keeps them typed`,
      [...params, listedOnly]
    ),
    db.query(
      `SELECT a.agent_user_id, to_char(o.submitted_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, (o.status = 'fallen_through') AS fell, o.price_cents, l.price_cents AS list_cents,
              EXTRACT(EPOCH FROM (o.submitted_at - COALESCE(
                (SELECT min(ae.occurred_at) FROM audit_event ae WHERE ae.aggregate_type = 'listing' AND ae.aggregate_id = l.id::text AND ae.event_type = 'listing.published'),
                l.created_at))) / 86400 AS dom
         FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id AND l.transaction_type = 'sale'
         JOIN listing_agent_appointment a ON a.listing_id = o.listing_id AND ${covers("o.submitted_at")}
        WHERE o.status IN ('accepted','fallen_through') AND ${within("o.submitted_at")} AND ${who("a.agent_user_id")} AND ${listedAgent("a.agent_user_id")}`,
      [...params, listedOnly]
    ),
    db.query(
      `SELECT r.agent_id, to_char(r.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, r.rating, r.comment
         FROM agent_ratings r
        WHERE ${within("r.created_at")} AND ${who("r.agent_id")} AND ${listedAgent("r.agent_id")}
        ORDER BY r.created_at DESC LIMIT 20000`,
      [...params, listedOnly]
    )
  ]);

  return {
    agents: agents.rows.map((x): PerfAgent => ({
      agentId: String(x["id"]), name: String(x["display_name"]), ...(x["headline"] ? { headline: String(x["headline"]) } : {}),
      specialties: list(x["specialties"]), areas: list(x["service_suburbs"]).slice(0, 6), acceptingNew: x["accepting_new"] === true, activeListings: Number(x["active_listings"])
    })),
    offers: offers.rows.map((x): PerfOffer => {
      const list = x["list_cents"] == null ? undefined : Number(x["list_cents"]), dom = x["dom"] == null ? undefined : Number(x["dom"]);
      return {
        agentId: String(x["agent_user_id"]), date: String(x["day"]), fellThrough: x["fell"] === true, priceCents: Number(x["price_cents"]),
        ...(list !== undefined ? { listCents: list } : {}), ...(dom !== undefined && dom >= 0 ? { daysToSale: Math.floor(dom) } : {})
      };
    }),
    ratings: ratings.rows.map((x): PerfRating => ({ agentId: String(x["agent_id"]), date: String(x["day"]), rating: Number(x["rating"]), comment: String(x["comment"]) }))
  };
}

/** Recent rating comments for an agent: rating, comment and month only. No buyer is ever identified. */
export async function recentRatingComments(db: Queryable, agentId: string, limit = 5): Promise<{ rating: number; comment: string; month: string }[]> {
  const r = await db.query(
    `SELECT rating, comment, to_char(created_at AT TIME ZONE $2, 'YYYY-MM') AS month FROM agent_ratings
      WHERE agent_id = $1::uuid AND comment <> '' ORDER BY created_at DESC LIMIT $3::int`,
    [agentId, ANALYTICS_TIME_ZONE, limit]
  );
  return r.rows.map(x => ({ rating: Number(x["rating"]), comment: String(x["comment"]), month: String(x["month"]) }));
}

export async function listFavorites(db: Queryable, ownerId: string): Promise<Set<string>> {
  const r = await db.query("SELECT agent_id FROM agent_favorite WHERE owner_id = $1::uuid", [ownerId]);
  return new Set(r.rows.map(x => String(x["agent_id"])));
}

/** Owners only. The agent must be a marketplace agent; marking twice is harmless. */
export async function setFavorite(db: Queryable, actor: Actor, agentId: string, on: boolean): Promise<Result<{ favorite: boolean }>> {
  if (actor.userType !== "owner") return fail("forbidden", "Only owners keep favourite agents.");
  if (on) {
    const ok = await db.query(`SELECT 1 FROM app_user u JOIN agent_profile p ON p.user_id = u.id WHERE u.id = $1::uuid AND ${LISTED}`, [agentId]);
    if (!ok.rows[0]) return fail("not_found", "Agent not found.");
    await db.query("INSERT INTO agent_favorite (owner_id, agent_id) VALUES ($1::uuid,$2::uuid) ON CONFLICT DO NOTHING", [actor.userId, agentId]);
  } else {
    await db.query("DELETE FROM agent_favorite WHERE owner_id = $1::uuid AND agent_id = $2::uuid", [actor.userId, agentId]);
  }
  return { ok: true, value: { favorite: on } };
}

/**
 * Sales the signed-in buyer can still rate: their accepted offers (standing, not fallen through) on sale listings that had an agent appointed
 * when the offer was made, with no rating from them yet. Only the listing's address and the agent's name are returned.
 */
export async function pendingRatings(db: Queryable, actor: Actor): Promise<{ listingId: string; address: string; agentName: string }[]> {
  if (actor.userType !== "buyer") return [];
  const r = await db.query(
    `SELECT DISTINCT ON (o.listing_id) o.listing_id, l.suburb, l.title, u.display_name
       FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
       JOIN listing_agent_appointment a ON a.listing_id = o.listing_id AND ${covers("o.submitted_at")}
       JOIN app_user u ON u.id = a.agent_user_id
      WHERE o.buyer_user_id = $1::uuid AND o.status = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM agent_ratings g WHERE g.listing_id = o.listing_id AND g.buyer_id = o.buyer_user_id)
      ORDER BY o.listing_id, o.submitted_at DESC LIMIT 50`,
    [actor.userId]
  );
  return r.rows.map(x => ({ listingId: String(x["listing_id"]), address: [x["title"], x["suburb"]].filter(Boolean).map(String).join(", ") || "Your purchase", agentName: String(x["display_name"]) }));
}

/** A buyer rates the agent appointed when their accepted offer was made, once per sale. The agent is worked out here, never taken from the request. */
export async function submitAgentRating(db: Queryable, actor: Actor, body: unknown, now: string): Promise<Result<{ id: string }>> {
  if (actor.userType !== "buyer") return fail("forbidden", "Only buyers rate an agent after a sale.");
  const v = parseRating(body);
  if (!v.ok) return v;
  const found = await db.query(
    `SELECT a.agent_user_id FROM formal_offer o JOIN listing_agent_appointment a ON a.listing_id = o.listing_id AND ${covers("o.submitted_at")}
      WHERE o.listing_id = $1::uuid AND o.buyer_user_id = $2::uuid AND o.status = 'accepted' ORDER BY o.submitted_at DESC LIMIT 1`,
    [v.value.listingId, actor.userId]
  ).catch(() => null);
  const agentId = found?.rows[0] ? String(found.rows[0]["agent_user_id"]) : undefined;
  if (!agentId) return fail("forbidden", "You can rate an agent once an offer of yours has been accepted on a listing they managed.");
  const id = randomUUID();
  try {
    await db.query("INSERT INTO agent_ratings (id, agent_id, listing_id, buyer_id, rating, comment, created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::timestamptz)",
      [id, agentId, v.value.listingId, actor.userId, v.value.rating, v.value.comment, now]);
  } catch (e) {
    if (isUniqueViolation(e)) return fail("conflict", "You have already rated this sale.");
    throw e;
  }
  await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: actor.userId, aggregateType: "agent_rating", aggregateId: id, eventType: "agent_rating.submitted", correlationId: randomUUID(), payload: { agentId, rating: v.value.rating } });
  await notifyUser(db, agentId, "review_received", { name: "A buyer", link: "/agent/my-performance" });
  return { ok: true, value: { id } };
}
