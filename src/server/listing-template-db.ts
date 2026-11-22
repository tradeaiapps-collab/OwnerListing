import type { TemplateContent, TemplateDeps, TemplateRecord } from "../domain/listing-template";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL; ids and text only travel as bound parameters.
const COLS = "id, created_by, team_id, name, note, category, furnishing, content, updated_at";
const recOf = (x: Record<string, unknown>): TemplateRecord => ({
  id: String(x["id"]), createdBy: String(x["created_by"]), ...(x["team_id"] ? { teamId: String(x["team_id"]) } : {}), name: String(x["name"]),
  ...(x["note"] ? { note: String(x["note"]) } : {}), category: String(x["category"]) as TemplateRecord["category"],
  ...(x["furnishing"] ? { furnishing: String(x["furnishing"]) as TemplateRecord["furnishing"] } : {}),
  content: (typeof x["content"] === "string" ? JSON.parse(x["content"]) : x["content"]) as TemplateContent,
  updatedAt: x["updated_at"] instanceof Date ? x["updated_at"].toISOString() : new Date(String(x["updated_at"])).toISOString()
});

export function createTemplateDeps(db: Queryable, now: () => Date = () => new Date()): TemplateDeps {
  return {
    now,
    async memberships(userId) {
      const r = await db.query(
        `SELECT t.id, t.name, m.role FROM agent_team_member m JOIN agent_team t ON t.id = m.team_id
          WHERE m.user_id = $1::uuid AND m.status = 'active' AND t.archived_at IS NULL`, [userId]);
      return r.rows.map(x => ({ teamId: String(x["id"]), teamName: String(x["name"]), role: String(x["role"]) as "principal" | "manager" | "agent" }));
    },
    async count(userId) {
      const r = await db.query("SELECT count(*) AS n FROM listing_template WHERE created_by = $1::uuid", [userId]);
      return Number(r.rows[0]?.["n"] ?? 0);
    },
    async insert(t) {
      const r = await db.query(
        `INSERT INTO listing_template (created_by, team_id, name, note, category, furnishing, content) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb) RETURNING ${COLS}`,
        [t.createdBy, t.teamId ?? null, t.name, t.note ?? null, t.category, t.furnishing ?? null, JSON.stringify(t.content)]);
      return recOf(r.rows[0]!);
    },
    async get(id) {
      const r = await db.query(`SELECT ${COLS} FROM listing_template WHERE id = $1::uuid`, [id]);
      return r.rows[0] ? recOf(r.rows[0]) : undefined;
    },
    async list(userId, teamIds) {
      const r = await db.query(
        `SELECT ${COLS} FROM listing_template WHERE (team_id IS NULL AND created_by = $1::uuid) OR team_id = ANY($2::uuid[])
          ORDER BY (team_id IS NOT NULL), name, id LIMIT 300`, [userId, teamIds]);
      return r.rows.map(recOf);
    },
    async update(id, t) {
      await db.query(
        "UPDATE listing_template SET team_id = $2::uuid, name = $3, note = $4, category = $5, furnishing = $6, content = $7::jsonb, updated_at = now() WHERE id = $1::uuid",
        [id, t.teamId ?? null, t.name, t.note ?? null, t.category, t.furnishing ?? null, JSON.stringify(t.content)]);
    },
    async remove(id) { await db.query("DELETE FROM listing_template WHERE id = $1::uuid", [id]); },
    async listingContent(userId, listingId) {
      // Owner, or an agent with an active appointment. Title, address, suburb, price and map pin are deliberately not selected.
      const r = await db.query(
        `SELECT l.description, l.property_type, l.use_class, l.transaction_type, l.jurisdiction, l.bedrooms, l.bathrooms, l.parking, l.amenities
           FROM property_listing l
          WHERE l.id = $2::uuid AND (l.owner_user_id = $1::uuid OR EXISTS
                (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $1::uuid AND a.revoked_at IS NULL))`, [userId, listingId]);
      const x = r.rows[0]; if (!x) return undefined;
      const c: TemplateContent = {};
      if (x["description"]) c.description = String(x["description"]);
      c.propertyType = String(x["property_type"]); c.useClass = String(x["use_class"]) as "residential" | "commercial"; c.transactionType = String(x["transaction_type"]) as "sale" | "rent"; c.jurisdiction = String(x["jurisdiction"]).trim();
      for (const [k, col] of [["bedrooms", "bedrooms"], ["bathrooms", "bathrooms"], ["parking", "parking"]] as const) if (x[col] != null) c[k] = Number(x[col]);
      if (Array.isArray(x["amenities"]) && x["amenities"].length) c.amenities = x["amenities"] as TemplateContent["amenities"] & string[];
      return c;
    }
  };
}
export const getTemplateDeps = (): TemplateDeps => createTemplateDeps(getDb());
