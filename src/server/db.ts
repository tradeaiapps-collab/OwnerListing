import type { AuditEvent } from "../domain/audit";
import type { ListingRecord, ListingRepository } from "../domain/listing-service";
import type { PropertyListing } from "../domain/listing";
import type { BondPathway } from "../domain/publish";
import { buildSearch } from "./listing-search-sql";
import { isJurisdiction } from "../domain/jurisdiction";
import type { AgentLicence } from "../domain/licence";
import type { AgentAppointment } from "../domain/access";

/** The part of pg.Pool this app uses, so tests and the domain do not depend on the driver. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface ListingRow {
  id: string; owner_user_id: string; owner_user_type: string; jurisdiction: string; status: string;
  title: string; property_type: string; use_class: string; transaction_type: string; address_text: string;
  created_at: Date | string; updated_at: Date | string; listing_fee_paid: boolean; terms_accepted: boolean;
  rental_bond_pathway: string | null;
  suburb: string | null; postcode: string | null; price_cents: string | number | null;
  bedrooms: number | null; bathrooms: number | null; parking: number | null;
}
interface DisclosureRow { listing_id: string; jurisdiction: string; disclosure_key: string; satisfied: boolean; evidence_reference: string | null }

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const SELECT = `SELECT l.id, l.owner_user_id, u.user_type AS owner_user_type, l.jurisdiction, l.status, l.title,
  l.property_type, l.use_class, l.transaction_type, l.address_text, l.created_at, l.updated_at,
  l.listing_fee_paid, l.terms_accepted, l.rental_bond_pathway,
  l.suburb, l.postcode, l.price_cents, l.bedrooms, l.bathrooms, l.parking
  FROM property_listing l JOIN app_user u ON u.id = l.owner_user_id`;

function toRecord(r: ListingRow, disclosures: DisclosureRow[]): ListingRecord {
  const listing = {
    id: r.id, ownerUserId: r.owner_user_id, ownerUserType: r.owner_user_type, jurisdiction: r.jurisdiction.trim(),
    status: r.status, title: r.title, propertyType: r.property_type, useClass: r.use_class,
    transactionType: r.transaction_type, address: r.address_text,
    ...(r.suburb !== null ? { suburb: r.suburb } : {}),
    ...(r.postcode !== null ? { postcode: r.postcode.trim() } : {}),
    ...(r.price_cents !== null ? { priceCents: Number(r.price_cents) } : {}), // BIGINT arrives as a string
    ...(r.bedrooms !== null ? { bedrooms: r.bedrooms } : {}),
    ...(r.bathrooms !== null ? { bathrooms: r.bathrooms } : {}),
    ...(r.parking !== null ? { parking: r.parking } : {}),
    disclosures: disclosures.map(d => ({
      key: d.disclosure_key, jurisdiction: d.jurisdiction.trim(), satisfied: d.satisfied,
      ...(d.evidence_reference ? { evidenceReference: d.evidence_reference } : {})
    })),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
  } as PropertyListing;
  return {
    listing, listingFeePaid: r.listing_fee_paid, termsAccepted: r.terms_accepted,
    ...(r.rental_bond_pathway ? { rentalBondPathway: r.rental_bond_pathway as BondPathway } : {})
  };
}

const COLS = "(id, owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, status, created_at, updated_at, listing_fee_paid, terms_accepted, rental_bond_pathway, suburb, postcode, price_cents, bedrooms, bathrooms, parking)";
const params = (r: ListingRecord) => {
  const l = r.listing;
  return [l.id, l.ownerUserId, l.jurisdiction, l.transactionType, l.useClass, l.propertyType, l.title, l.address,
    l.status, l.createdAt, l.updatedAt, r.listingFeePaid, r.termsAccepted, r.rentalBondPathway ?? null,
    l.suburb ?? null, l.postcode ?? null, l.priceCents ?? null, l.bedrooms ?? null, l.bathrooms ?? null, l.parking ?? null];
};

/**
 * PostgreSQL listing store. Disclosures are verified by staff and are read here, never written by the listing API.
 * Only parameterised queries; no string-built SQL.
 */
export function createPgListingRepository(db: Queryable): ListingRepository {
  async function disclosuresFor(ids: string[]): Promise<Map<string, DisclosureRow[]>> {
    const map = new Map<string, DisclosureRow[]>();
    if (ids.length === 0) return map;
    const res = await db.query(
      "SELECT listing_id, jurisdiction, disclosure_key, satisfied, evidence_reference FROM listing_disclosure WHERE listing_id = ANY($1::uuid[])",
      [ids]
    );
    for (const row of res.rows as unknown as DisclosureRow[]) {
      const list = map.get(row.listing_id) ?? [];
      list.push(row);
      map.set(row.listing_id, list);
    }
    return map;
  }

  return {
    async insert(r) {
      await db.query(`INSERT INTO property_listing ${COLS} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, params(r));
    },
    async save(r) {
      const l = r.listing;
      await db.query(
        `UPDATE property_listing SET jurisdiction=$3, transaction_type=$4, use_class=$5, property_type=$6, title=$7,
         address_text=$8, status=$9, updated_at=$10, listing_fee_paid=$11, terms_accepted=$12, rental_bond_pathway=$13,
         suburb=$14, postcode=$15, price_cents=$16, bedrooms=$17, bathrooms=$18, parking=$19 WHERE id=$1 AND owner_user_id=$2`,
        [l.id, l.ownerUserId, l.jurisdiction, l.transactionType, l.useClass, l.propertyType, l.title, l.address,
          l.status, l.updatedAt, r.listingFeePaid, r.termsAccepted, r.rentalBondPathway ?? null,
          l.suburb ?? null, l.postcode ?? null, l.priceCents ?? null, l.bedrooms ?? null, l.bathrooms ?? null, l.parking ?? null]
      );
    },
    async get(id) {
      const res = await db.query(`${SELECT} WHERE l.id = $1`, [id]);
      const row = res.rows[0] as unknown as ListingRow | undefined;
      if (!row) return undefined;
      return toRecord(row, (await disclosuresFor([row.id])).get(row.id) ?? []);
    },
    async search(q) {
      const { where, params: p, orderBy } = buildSearch(q);
      const count = await db.query(`SELECT count(*) AS n FROM property_listing l WHERE ${where}`, p);
      const total = Number((count.rows[0] as { n: string | number }).n);
      const res = await db.query(
        `${SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
        [...p, q.pageSize, (q.page - 1) * q.pageSize]
      );
      const rows = res.rows as unknown as ListingRow[];
      const ds = await disclosuresFor(rows.map(r => r.id));
      return { items: rows.map(r => toRecord(r, ds.get(r.id) ?? [])), total, page: q.page, pageSize: q.pageSize };
    },
    async listByOwner(ownerUserId) {
      const res = await db.query(`${SELECT} WHERE l.owner_user_id = $1 ORDER BY l.created_at DESC`, [ownerUserId]);
      const rows = res.rows as unknown as ListingRow[];
      const ds = await disclosuresFor(rows.map(r => r.id));
      return rows.map(r => toRecord(r, ds.get(r.id) ?? []));
    }
  };
}

/** Active appointment of an agent to a listing. Parameterised; returns undefined when none is active. */
export async function appointmentForPg(db: Queryable, listingId: string, agentUserId: string): Promise<AgentAppointment | undefined> {
  const res = await db.query(
    "SELECT listing_id, agent_user_id, scope FROM listing_agent_appointment WHERE listing_id = $1 AND agent_user_id = $2 AND revoked_at IS NULL",
    [listingId, agentUserId]
  );
  const row = res.rows[0];
  if (!row) return undefined;
  return {
    listingId: String(row["listing_id"]), agentUserId: String(row["agent_user_id"]),
    scope: row["scope"] === "full" ? "full" : "enquiries_and_offers", revoked: false
  };
}

export async function appendAuditPg(db: Queryable, e: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [e.id, e.occurredAt, e.actorType, e.actorId, e.aggregateType, e.aggregateId, e.eventType, e.correlationId, JSON.stringify(e.payload)]
  );
}

/**
 * Verified agent licences only (read-only, constant query, no user input). Anything not verified is never
 * loaded, so the publish gate stays fail-closed. Expiry is judged by the domain (hasVerifiedLicence), not here.
 * This code never writes licence rows: verification is a Compliance action (see db/002).
 */
export async function verifiedLicencesPg(db: Queryable): Promise<AgentLicence[]> {
  const res = await db.query(
    `SELECT user_id, jurisdiction, status, to_char(expires_at, 'YYYY-MM-DD') AS expires_at
     FROM agent_licence WHERE status = 'verified'`
  );
  const out: AgentLicence[] = [];
  for (const r of res.rows) {
    const jurisdiction = String(r["jurisdiction"]).trim();
    if (!isJurisdiction(jurisdiction)) continue;
    const expiresAt = r["expires_at"];
    out.push({
      userId: String(r["user_id"]), jurisdiction, status: "verified",
      ...(typeof expiresAt === "string" ? { expiresAt } : {})
    });
  }
  return out;
}
