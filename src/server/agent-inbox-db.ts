import type { AgentInboxDeps, AgentListingItem } from "../domain/agent-inbox";
import { isJurisdiction } from "../domain/jurisdiction";
import { getDb } from "./context";
import { verifiedLicencesPg, type Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/**
 * Listings the agent is actively appointed to, with thread counts and unread messages for this agent
 * (same unread rule as the enquiry inbox: from the other side, newer than the agent's last read).
 * Constant SQL; the agent id is the only parameter.
 */
export async function appointedListingsPg(db: Queryable, agentUserId: string): Promise<AgentListingItem[]> {
  const r = await db.query(
    `SELECT l.id, l.title, l.jurisdiction, l.status, a.appointed_at,
            (SELECT count(*) FROM enquiry e WHERE e.listing_id = l.id) AS enquiries,
            (SELECT count(*) FROM enquiry e
               JOIN enquiry_message m ON m.enquiry_id = e.id
               LEFT JOIN enquiry_read rd ON rd.enquiry_id = e.id AND rd.user_id = $1::uuid
              WHERE e.listing_id = l.id AND m.sender_user_id IS DISTINCT FROM $1::uuid
                AND (rd.last_read_at IS NULL OR m.sent_at > rd.last_read_at)) AS unread
       FROM listing_agent_appointment a
       JOIN property_listing l ON l.id = a.listing_id
      WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL
      ORDER BY a.appointed_at DESC, l.id LIMIT 200`,
    [agentUserId]
  );
  return r.rows.flatMap((x): AgentListingItem[] => {
    const jurisdiction = String(x["jurisdiction"]).trim();
    if (!isJurisdiction(jurisdiction)) return [];
    return [{
      listingId: String(x["id"]), title: String(x["title"]), jurisdiction, status: String(x["status"]),
      appointedAt: iso(x["appointed_at"]), enquiries: Number(x["enquiries"]), unread: Number(x["unread"])
    }];
  });
}

export function createAgentInboxDeps(db: Queryable, now: () => Date = () => new Date()): AgentInboxDeps {
  return {
    appointedListings: id => appointedListingsPg(db, id),
    licences: () => verifiedLicencesPg(db),
    today: () => now().toISOString().slice(0, 10)
  };
}

export const getAgentInboxDeps = (): AgentInboxDeps => createAgentInboxDeps(getDb());
