import { randomUUID } from "node:crypto";
import { personaById } from "../domain/assistant-persona";
import { CHAT_TOPICS, type AssistantTurn, type AssistantTurnRepository, type ChatAssistantDeps, type ChatMarket, type ChatOffer, type ChatPose, type ChatRole, type ChatTopic } from "../domain/chat-assistant";
import { marketInsights } from "../domain/property-intelligence";
import { loadLivePersona } from "./assistant-persona-db";
import { getDb } from "./context";
import type { Queryable } from "./db";
import { getEnquiryDeps } from "./enquiry-db";
import { getIntelligenceSource } from "./property-intelligence";

// Constant SQL; user input only travels as bound parameters. No UPDATE or DELETE on enquiry_assistant_turn (db trigger too).
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const topic = (v: unknown): ChatTopic => ((CHAT_TOPICS as readonly string[]).includes(String(v)) ? (String(v) as ChatTopic) : "unknown");

export function createPgTurnRepository(db: Queryable): AssistantTurnRepository {
  return {
    async add(t) {
      await db.query(
        `INSERT INTO enquiry_assistant_turn (id, enquiry_id, asked_by_user_id, asked_by_role, question, topic, pose, answer, created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::timestamptz)`,
        [t.id, t.enquiryId, t.askedByUserId, t.askedByRole, t.question, t.topic, t.pose, t.answer, t.createdAt]
      );
    },
    async list(enquiryId) {
      const r = await db.query("SELECT * FROM enquiry_assistant_turn WHERE enquiry_id = $1::uuid ORDER BY created_at, id LIMIT 500", [enquiryId]);
      return r.rows.map((x): AssistantTurn => ({
        id: String(x["id"]), enquiryId: String(x["enquiry_id"]), askedByUserId: String(x["asked_by_user_id"]),
        askedByRole: String(x["asked_by_role"]) as ChatRole, question: String(x["question"]), topic: topic(x["topic"]),
        pose: String(x["pose"]) as ChatPose, answer: String(x["answer"]), createdAt: iso(x["created_at"])
      }));
    }
  };
}

/** The buyer's newest formal offer on the listing and its newest counter. Terms both parties already see on their offer pages. */
export async function chatOfferPg(db: Queryable, listingId: string, buyerUserId: string): Promise<ChatOffer | undefined> {
  const o = (await db.query(
    `SELECT id, price_cents, deposit_cents, settlement_days, conditions, status FROM formal_offer
      WHERE listing_id = $1::uuid AND buyer_user_id = $2::uuid ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    [listingId, buyerUserId]
  )).rows[0];
  if (!o) return undefined;
  const c = (await db.query(
    `SELECT from_party, price_cents, deposit_cents, settlement_days, conditions, status FROM offer_counter
      WHERE offer_id = $1::uuid ORDER BY round DESC LIMIT 1`,
    [o["id"]]
  )).rows[0];
  return {
    priceCents: Number(o["price_cents"]), depositCents: Number(o["deposit_cents"]), settlementDays: Number(o["settlement_days"]),
    conditions: strings(o["conditions"]), status: String(o["status"]),
    ...(c ? {
      counter: {
        fromParty: String(c["from_party"]) === "buyer" ? "buyer" as const : "owner" as const, priceCents: Number(c["price_cents"]),
        depositCents: Number(c["deposit_cents"]), settlementDays: Number(c["settlement_days"]), conditions: strings(c["conditions"]), status: String(c["status"])
      }
    } : {})
  };
}

export async function verifiedDisclosuresPg(db: Queryable, listingId: string): Promise<number> {
  const r = await db.query("SELECT count(*) AS n FROM listing_disclosure WHERE listing_id = $1::uuid AND state = 'verified'", [listingId]);
  return Number(r.rows[0]?.["n"] ?? 0);
}

export function getChatAssistantDeps(): ChatAssistantDeps {
  const db = getDb();
  const e = getEnquiryDeps();
  return {
    enquiries: e.enquiries, listings: e.listings, termsCurrentFor: e.termsCurrentFor, countHit: e.countHit, now: e.now, newId: () => randomUUID(),
    ...(e.appointmentFor ? { appointmentFor: e.appointmentFor } : {}),
    ...(e.licences ? { licences: e.licences } : {}),
    appendAudit: e.appendAudit,
    turns: createPgTurnRepository(db),
    offerFor: (listingId, buyerUserId) => chatOfferPg(db, listingId, buyerUserId),
    verifiedDisclosures: listingId => verifiedDisclosuresPg(db, listingId),
    marketFor: l => chatMarketPg(db, l),
    persona: async () => {
      const p = personaById(await loadLivePersona(db));
      return { id: p.id, name: p.name, icon: p.icon, portrait: p.portrait, poses: p.poses };
    }
  };
}

/** Suburb market brief for the chat, from the same source as the property intelligence pages. Undefined when there is too little data. */
export async function chatMarketPg(db: Queryable, l: { suburb?: string | undefined; postcode?: string | undefined; transactionType: "sale" | "rent"; propertyType: string }): Promise<ChatMarket | undefined> {
  if (!l.suburb && !l.postcode) return undefined;
  const now = new Date().toISOString();
  const subject = { transactionType: l.transactionType, propertyType: l.propertyType, ...(l.suburb ? { suburb: l.suburb } : {}), ...(l.postcode ? { postcode: l.postcode } : {}) };
  const m = marketInsights(subject, await getIntelligenceSource(db).find(subject, now), now);
  if (m.state !== "ready") return undefined;
  return {
    area: l.suburb ?? l.postcode ?? "this area", medianCents: m.medianCents, sampleSize: m.sampleSize, change12mPercent: m.change12mPercent,
    change6mPercent: m.change6mPercent, velocity: m.velocity, medianDaysOnMarket: m.medianDaysOnMarket
  };
}
