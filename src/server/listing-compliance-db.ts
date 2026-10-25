import type { Queryable } from "./db";
import { trustAccountDecisionPg } from "./db";
import { isJurisdiction } from "../domain/jurisdiction";
import type { AgentLicence } from "../domain/licence";
import { listingRequiredKeysPg } from "./disclosure-config-db";
import type { ComplianceFacts } from "../domain/listing-compliance";
import type { PropertyListing } from "../domain/listing";

/**
 * Reads the staff-verified facts behind a listing's public compliance panel. Parameterised queries only.
 * The caller has already decided the listing may be seen (getListing), so this never checks visibility itself.
 */
export async function listingComplianceFactsPg(db: Queryable, l: PropertyListing): Promise<ComplianceFacts> {
  const [appt, created, disc, firm, trust, required] = await Promise.all([
    db.query(
      `SELECT agent_user_id, appointed_at FROM listing_agent_appointment WHERE listing_id = $1 AND revoked_at IS NULL`,
      [l.id]
    ),
    db.query(`SELECT created_at FROM property_listing WHERE id = $1`, [l.id]),
    db.query(
      `SELECT disclosure_key, satisfied, verified_at FROM listing_disclosure WHERE listing_id = $1 ORDER BY disclosure_key`,
      [l.id]
    ),
    db.query(
      `SELECT f.name FROM trust_account_check c JOIN trust_account a ON a.id = c.trust_account_id JOIN law_firm f ON f.id = a.firm_id
        WHERE c.listing_id = $1 ORDER BY c.checked_at DESC, c.id LIMIT 1`,
      [l.id]
    ),
    trustAccountDecisionPg(db, l.id),
    listingRequiredKeysPg(db, l)
  ]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  const facts: ComplianceFacts = {
    jurisdiction: l.jurisdiction,
    createdAt: created.rows[0] ? iso(created.rows[0]["created_at"]) : l.createdAt,
    disclosures: disc.rows.map(r => {
      const d: { key: string; satisfied: boolean; verifiedAt?: string } = { key: String(r["disclosure_key"]), satisfied: r["satisfied"] === true };
      if (r["verified_at"] != null) d.verifiedAt = iso(r["verified_at"]);
      return d;
    }),
    required
  };
  if (trust) facts.trust = trust;
  const firmName = firm.rows[0]?.["name"];
  if (typeof firmName === "string") facts.firmName = firmName;
  const a = appt.rows[0];
  if (a) {
    const userId = String(a["agent_user_id"]);
    // Verified rows only, as in verifiedLicencesPg; expiry is judged by the domain.
    const lic = await db.query(
      `SELECT jurisdiction, to_char(expires_at, 'YYYY-MM-DD') AS expires_at FROM agent_licence WHERE user_id = $1 AND status = 'verified'`,
      [userId]
    );
    const licences: AgentLicence[] = [];
    for (const r of lic.rows) {
      const j = String(r["jurisdiction"]).trim();
      if (!isJurisdiction(j)) continue;
      const exp = r["expires_at"];
      licences.push({ userId, jurisdiction: j, status: "verified", ...(typeof exp === "string" ? { expiresAt: exp } : {}) });
    }
    facts.agent = { userId, appointedAt: iso(a["appointed_at"]), licences };
  }
  return facts;
}
