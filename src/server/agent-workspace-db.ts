import { median, type LeadFact, type NoteFact, type NoteKind, type OfferFacts, type PeerFacts, type Stage, type WorkspaceDeps } from "../domain/agent-workspace";
import { personaById } from "../domain/assistant-persona";
import { loadLivePersona } from "./assistant-persona-db";
import { getDb } from "./context";
import { verifiedLicencesPg, type Queryable } from "./db";

// Constant SQL; ids and text only travel as bound parameters. Everything is scoped to listings the agent is actively appointed to.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const opt = (v: unknown) => (v == null ? undefined : iso(v));

export async function leadsPg(db: Queryable, agentId: string): Promise<LeadFact[]> {
  const r = await db.query(
    `SELECT e.id AS enquiry_id, l.id AS listing_id, l.title, l.property_type, u.id AS buyer_id, u.display_name, e.created_at,
            (SELECT count(*) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = e.buyer_user_id) AS buyer_msgs,
            (SELECT count(*) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = $1::uuid) AS agent_msgs,
            (SELECT max(m.sent_at) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = e.buyer_user_id) AS last_buyer_at,
            (SELECT min(m.sent_at) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = $1::uuid) AS first_agent_at,
            o.status AS offer_status, o.price_cents AS offer_price, s.stage, to_char(s.follow_up_at, 'YYYY-MM-DD') AS follow_up_at,
            (SELECT count(*) FROM agent_crm_note n WHERE n.agent_user_id = $1::uuid AND n.buyer_user_id = e.buyer_user_id) AS notes
       FROM listing_agent_appointment a
       JOIN property_listing l ON l.id = a.listing_id
       JOIN enquiry e ON e.listing_id = l.id
       JOIN app_user u ON u.id = e.buyer_user_id
       LEFT JOIN LATERAL (SELECT status, price_cents FROM formal_offer fo WHERE fo.listing_id = l.id AND fo.buyer_user_id = e.buyer_user_id
                           ORDER BY submitted_at DESC LIMIT 1) o ON true
       LEFT JOIN agent_lead_state s ON s.agent_user_id = $1::uuid AND s.enquiry_id = e.id
      WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL
      ORDER BY e.created_at DESC, e.id LIMIT 500`,
    [agentId]
  );
  return r.rows.map((x): LeadFact => ({
    enquiryId: String(x["enquiry_id"]), listingId: String(x["listing_id"]), listingTitle: String(x["title"]), buyerId: String(x["buyer_id"]),
    buyerName: String(x["display_name"]), enquiredAt: iso(x["created_at"]), buyerMessages: Number(x["buyer_msgs"]), agentMessages: Number(x["agent_msgs"]),
    notes: Number(x["notes"]), ...(x["property_type"] ? { propertyType: String(x["property_type"]) } : {}),
    ...(opt(x["last_buyer_at"]) ? { lastBuyerAt: opt(x["last_buyer_at"])! } : {}), ...(opt(x["first_agent_at"]) ? { firstAgentAt: opt(x["first_agent_at"])! } : {}),
    ...(x["offer_status"] ? { offerStatus: String(x["offer_status"]), offerPriceCents: Number(x["offer_price"]) } : {}),
    ...(x["stage"] ? { stage: String(x["stage"]) as Stage } : {}), ...(x["follow_up_at"] ? { followUpAt: String(x["follow_up_at"]) } : {})
  }));
}

export async function offersPg(db: Queryable, agentId: string): Promise<OfferFacts> {
  const r = await db.query(
    `SELECT (SELECT count(*) FROM listing_agent_appointment WHERE agent_user_id = $1::uuid AND revoked_at IS NULL) AS listings,
            count(*) FILTER (WHERE o.status IN ('submitted','under_review','countered')) AS open,
            COALESCE(sum(o.price_cents) FILTER (WHERE o.status IN ('submitted','under_review','countered')), 0) AS open_cents,
            count(*) FILTER (WHERE o.status = 'accepted') AS accepted,
            COALESCE(sum(o.price_cents) FILTER (WHERE o.status = 'accepted'), 0) AS accepted_cents,
            count(*) FILTER (WHERE o.status = 'rejected') AS rejected
       FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id
      WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL`,
    [agentId]
  );
  const x = r.rows[0] ?? {};
  return { listings: Number(x["listings"] ?? 0), open: Number(x["open"] ?? 0), openCents: Number(x["open_cents"] ?? 0), accepted: Number(x["accepted"] ?? 0), acceptedCents: Number(x["accepted_cents"] ?? 0), rejected: Number(x["rejected"] ?? 0) };
}

/** Other agents, anonymously: per-agent acceptance rate and median first reply, summarised as a median. Counts only; no ids leave this function. */
export async function peersPg(db: Queryable, agentId: string): Promise<PeerFacts> {
  const o = await db.query(
    `SELECT a.agent_user_id, count(*) FILTER (WHERE o.status IN ('accepted','rejected')) AS decided, count(*) FILTER (WHERE o.status = 'accepted') AS accepted
       FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id
      WHERE a.revoked_at IS NULL AND a.agent_user_id <> $1::uuid GROUP BY a.agent_user_id`, [agentId]);
  const t = await db.query(
    `SELECT a.agent_user_id, EXTRACT(EPOCH FROM (min(m.sent_at) - e.created_at)) / 60 AS mins
       FROM listing_agent_appointment a JOIN enquiry e ON e.listing_id = a.listing_id
       JOIN enquiry_message m ON m.enquiry_id = e.id AND m.sender_user_id = a.agent_user_id
      WHERE a.revoked_at IS NULL AND a.agent_user_id <> $1::uuid GROUP BY a.agent_user_id, e.id, e.created_at`, [agentId]);
  const rates = o.rows.filter(x => Number(x["decided"]) > 0).map(x => Math.round((Number(x["accepted"]) / Number(x["decided"])) * 100));
  const byAgent = new Map<string, number[]>();
  for (const x of t.rows) { const m = Number(x["mins"]); if (m >= 0) byAgent.set(String(x["agent_user_id"]), [...(byAgent.get(String(x["agent_user_id"])) ?? []), m]); }
  const resp = median([...byAgent.values()].map(v => median(v)!));
  const agents = new Set([...o.rows.map(x => String(x["agent_user_id"])), ...byAgent.keys()]).size;
  const rate = median(rates);
  return { agents, ...(rate !== undefined ? { acceptanceRate: rate } : {}), ...(resp !== undefined ? { medianResponseMinutes: resp } : {}) };
}

export async function platformRatePg(db: Queryable): Promise<number | undefined> {
  const r = await db.query(`SELECT count(*) FILTER (WHERE status IN ('accepted','rejected')) AS decided, count(*) FILTER (WHERE status = 'accepted') AS accepted FROM formal_offer`);
  const d = Number(r.rows[0]?.["decided"] ?? 0);
  return d >= 10 ? Math.round((Number(r.rows[0]?.["accepted"]) / d) * 100) : undefined;
}

export function createWorkspaceDeps(db: Queryable, now: () => Date = () => new Date()): WorkspaceDeps {
  return {
    licences: () => verifiedLicencesPg(db), today: () => now().toISOString().slice(0, 10), now,
    leads: id => leadsPg(db, id), offers: id => offersPg(db, id), peers: id => peersPg(db, id), platformRate: () => platformRatePg(db),
    async notes(agentId, buyerId) {
      const r = await db.query("SELECT kind, body, created_at FROM agent_crm_note WHERE agent_user_id = $1::uuid AND buyer_user_id = $2::uuid ORDER BY created_at DESC, id LIMIT 200", [agentId, buyerId]);
      return r.rows.map((x): NoteFact => ({ kind: String(x["kind"]) as NoteKind, body: String(x["body"]), createdAt: iso(x["created_at"]) }));
    },
    async addNote(agentId, buyerId, kind, body, at) {
      await db.query("INSERT INTO agent_crm_note (agent_user_id, buyer_user_id, kind, body, created_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz)", [agentId, buyerId, kind, body, at]);
    },
    async setStage(agentId, enquiryId, stage, followUpAt) {
      await db.query(
        `INSERT INTO agent_lead_state (agent_user_id, enquiry_id, stage, follow_up_at) VALUES ($1::uuid,$2::uuid,$3,$4::date)
         ON CONFLICT (agent_user_id, enquiry_id) DO UPDATE SET stage = EXCLUDED.stage, follow_up_at = EXCLUDED.follow_up_at, updated_at = now()`,
        [agentId, enquiryId, stage, followUpAt]);
    },
    personaName: async () => personaById(await loadLivePersona(db)).name
  };
}
export const getWorkspaceDeps = (): WorkspaceDeps => createWorkspaceDeps(getDb());
