import { createHash, randomUUID } from "node:crypto";
import { parseStoredTheme, type ThemeSettings } from "../domain/site-theme";
import { MAX_DOMAINS_PER_TENANT, type TenantStatus, type TenantView } from "../domain/white-label";
import type { AssetMime } from "../domain/site-asset";
import { appendAuditPg, type Queryable } from "./db";

/** Persistence for white-label tenants. All SQL is constant text with bound parameters; settings are validated (buildTenantSettings) before they reach this layer. */

export interface DomainRow { host: string; verifyToken: string; verifiedAt: string | null }
export interface TenantRow {
  id: string; teamId: string; teamName: string; status: TenantStatus; settings: ThemeSettings;
  logoLightId: number | null; faviconId: number | null; updatedAt: string; reviewedAt: string | null; domains: DomainRow[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown) => (v == null ? null : iso(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const settingsOf = (v: unknown): ThemeSettings => parseStoredTheme(typeof v === "string" ? JSON.parse(v) : v);

async function inTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error("Transactions are required.");
  return db.transaction(fn);
}

const audit = (db: Queryable, actorId: string, eventType: string, tenantId: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId, aggregateType: "white_label_tenant",
    aggregateId: tenantId, eventType, correlationId: randomUUID(), payload
  });

const TENANT_SELECT =
  `SELECT t.id, t.team_id, g.name AS team_name, t.status, t.settings, t.logo_light_id, t.favicon_id, t.updated_at, t.reviewed_at
     FROM white_label_tenant t JOIN agency_team g ON g.id = t.team_id`;

async function withDomains(db: Queryable, rows: Record<string, unknown>[]): Promise<TenantRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => String(r["id"]));
  const d = await db.query(`SELECT tenant_id, host, verify_token, verified_at FROM white_label_domain WHERE tenant_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]);
  return rows.map(r => ({
    id: String(r["id"]), teamId: String(r["team_id"]), teamName: String(r["team_name"]), status: String(r["status"]) as TenantStatus,
    settings: settingsOf(r["settings"]), logoLightId: numOrNull(r["logo_light_id"]), faviconId: numOrNull(r["favicon_id"]),
    updatedAt: iso(r["updated_at"]), reviewedAt: isoOrNull(r["reviewed_at"]),
    domains: d.rows.filter(x => String(x["tenant_id"]) === String(r["id"])).map(x => ({ host: String(x["host"]), verifyToken: String(x["verify_token"]), verifiedAt: isoOrNull(x["verified_at"]) }))
  }));
}

/** The caller's role in the team, or null when they are not an active member. Branding is for managers only. */
export async function memberRole(db: Queryable, teamId: string, userId: string): Promise<string | null> {
  const r = await db.query(`SELECT role FROM agency_team_member WHERE team_id = $1::uuid AND user_id = $2::uuid AND removed_at IS NULL`, [teamId, userId]);
  return r.rows[0] ? String(r.rows[0]["role"]) : null;
}

export async function getTenantForTeam(db: Queryable, teamId: string): Promise<TenantRow | null> {
  return (await withDomains(db, (await db.query(`${TENANT_SELECT} WHERE t.team_id = $1::uuid`, [teamId])).rows))[0] ?? null;
}
export async function getTenant(db: Queryable, tenantId: string): Promise<TenantRow | null> {
  return (await withDomains(db, (await db.query(`${TENANT_SELECT} WHERE t.id = $1::uuid`, [tenantId])).rows))[0] ?? null;
}
export async function listTenants(db: Queryable): Promise<TenantRow[]> {
  return withDomains(db, (await db.query(`${TENANT_SELECT} ORDER BY (t.status = 'draft') DESC, t.updated_at DESC LIMIT 200`)).rows);
}

/**
 * Creates the team's tenant (as a draft) or updates its brand. Changing the display name of an active tenant sends it back to draft so
 * staff re-check it (an approved agency cannot swap in another company's name). Returns the tenant id and its resulting status.
 */
export async function saveBrand(db: Queryable, teamId: string, userId: string, settings: ThemeSettings): Promise<{ id: string; status: TenantStatus; resetToDraft: boolean }> {
  return inTx(db, async tx => {
    const cur = (await tx.query(`SELECT id, status, settings FROM white_label_tenant WHERE team_id = $1::uuid FOR UPDATE`, [teamId])).rows[0];
    if (!cur) {
      const id = randomUUID();
      await tx.query(`INSERT INTO white_label_tenant (id, team_id, settings, created_by) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::uuid)`, [id, teamId, JSON.stringify(settings), userId]);
      await audit(tx, userId, "white_label.created", id, { teamId });
      return { id, status: "draft", resetToDraft: false };
    }
    const id = String(cur["id"]);
    const before = settingsOf(cur["settings"]);
    const renamed = before.brand.siteName !== settings.brand.siteName;
    const status = String(cur["status"]) as TenantStatus;
    const reset = status === "active" && renamed;
    await tx.query(
      `UPDATE white_label_tenant SET settings = $2::jsonb, updated_at = now(), status = CASE WHEN $3::boolean THEN 'draft' ELSE status END WHERE id = $1::uuid`,
      [id, JSON.stringify(settings), reset]
    );
    await audit(tx, userId, "white_label.brand_saved", id, { renamed, resetToDraft: reset });
    return { id, status: reset ? "draft" : status, resetToDraft: reset };
  });
}

export type DomainOutcome = { ok: true } | { ok: false; code: "limit" | "taken" | "not_found"; error: string };

export async function addDomain(db: Queryable, tenantId: string, userId: string, host: string, token: string): Promise<DomainOutcome> {
  return inTx(db, async tx => {
    const n = Number((await tx.query(`SELECT count(*) AS n FROM white_label_domain WHERE tenant_id = $1::uuid`, [tenantId])).rows[0]!["n"]);
    if (n >= MAX_DOMAINS_PER_TENANT) return { ok: false, code: "limit", error: `At most ${MAX_DOMAINS_PER_TENANT} domains.` };
    const r = await tx.query(`INSERT INTO white_label_domain (host, tenant_id, verify_token, created_by) VALUES ($1, $2::uuid, $3, $4::uuid) ON CONFLICT (host) DO NOTHING RETURNING host`, [host, tenantId, token, userId]);
    if (r.rows.length === 0) return { ok: false, code: "taken", error: "That domain is already connected to an agency." };
    await audit(tx, userId, "white_label.domain_added", tenantId, { host });
    return { ok: true };
  });
}

export async function markVerified(db: Queryable, tenantId: string, host: string, userId: string): Promise<boolean> {
  const r = await db.query(`UPDATE white_label_domain SET verified_at = now() WHERE host = $1 AND tenant_id = $2::uuid AND verified_at IS NULL RETURNING host`, [host, tenantId]);
  if (r.rows.length > 0) await audit(db, userId, "white_label.domain_verified", tenantId, { host });
  return r.rows.length > 0;
}

export async function removeDomain(db: Queryable, tenantId: string, host: string, userId: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM white_label_domain WHERE host = $1 AND tenant_id = $2::uuid RETURNING host`, [host, tenantId]);
  if (r.rows.length > 0) await audit(db, userId, "white_label.domain_removed", tenantId, { host });
  return r.rows.length > 0;
}

/** Stores a logo or favicon and points the tenant at it. A new logo of an active tenant sends it back to draft for re-check. */
export async function insertAsset(
  db: Queryable, tenantId: string, userId: string, a: { slot: "logo-light" | "favicon"; contentType: AssetMime; bytes: Buffer; width: number; height: number }
): Promise<number> {
  return inTx(db, async tx => {
    const sha = createHash("sha256").update(a.bytes).digest("hex");
    const id = Number((await tx.query(
      `INSERT INTO white_label_asset (tenant_id, slot, content_type, bytes, sha256, width, height, created_by) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid) RETURNING id`,
      [tenantId, a.slot, a.contentType, a.bytes, sha, a.width, a.height, userId]
    )).rows[0]!["id"]);
    const col = a.slot === "logo-light" ? "logo_light_id" : "favicon_id";
    // col is one of two constants chosen above, never user text.
    await tx.query(`UPDATE white_label_tenant SET ${col} = $2, updated_at = now(), status = CASE WHEN status = 'active' THEN 'draft' ELSE status END WHERE id = $1::uuid`, [tenantId, id]);
    await audit(tx, userId, "white_label.asset_uploaded", tenantId, { slot: a.slot, contentType: a.contentType, bytes: a.bytes.length, sha256: sha });
    return id;
  });
}

export interface AssetFile { contentType: string; bytes: Buffer; sha256: string }
/** The tenant's logo or favicon with this id, only while it is the one the tenant currently points at. */
export async function loadAssetFile(db: Queryable, tenantId: string, slot: "logo-light" | "favicon", id: number): Promise<AssetFile | null> {
  const col = slot === "logo-light" ? "logo_light_id" : "favicon_id";
  const r = await db.query(
    `SELECT a.content_type, a.bytes, a.sha256 FROM white_label_asset a JOIN white_label_tenant t ON t.id = a.tenant_id AND t.${col} = a.id WHERE t.id = $1::uuid AND a.slot = $2 AND a.id = $3`,
    [tenantId, slot, id]
  );
  const row = r.rows[0];
  return row ? { contentType: String(row["content_type"]), bytes: Buffer.from(row["bytes"] as Buffer), sha256: String(row["sha256"]) } : null;
}

export type StatusOutcome = { ok: true; status: TenantStatus } | { ok: false; code: "not_found" | "no_domain"; error: string };

/** Staff decision. Activating needs at least one verified domain. */
export async function setStatus(db: Queryable, staffId: string, tenantId: string, status: TenantStatus, note: string): Promise<StatusOutcome> {
  return inTx(db, async tx => {
    const cur = (await tx.query(`SELECT status FROM white_label_tenant WHERE id = $1::uuid FOR UPDATE`, [tenantId])).rows[0];
    if (!cur) return { ok: false, code: "not_found", error: "No such agency brand." };
    if (status === "active") {
      const v = Number((await tx.query(`SELECT count(*) AS n FROM white_label_domain WHERE tenant_id = $1::uuid AND verified_at IS NOT NULL`, [tenantId])).rows[0]!["n"]);
      if (v === 0) return { ok: false, code: "no_domain", error: "The agency has no verified domain yet." };
    }
    await tx.query(`UPDATE white_label_tenant SET status = $2, reviewed_by = $3::uuid, reviewed_at = now(), updated_at = now() WHERE id = $1::uuid`, [tenantId, status, staffId]);
    await audit(tx, staffId, "white_label.status_set", tenantId, { from: String(cur["status"]), to: status, note: note.slice(0, 300) });
    return { ok: true, status };
  });
}

/** The active tenant that owns this host through a verified domain, or null (unknown host, unverified domain, draft or suspended tenant). */
export async function resolveByHost(db: Queryable, host: string): Promise<TenantView | null> {
  const r = await db.query(
    `SELECT t.id, t.settings, t.logo_light_id, t.favicon_id
       FROM white_label_domain d JOIN white_label_tenant t ON t.id = d.tenant_id
      WHERE d.host = $1 AND d.verified_at IS NOT NULL AND t.status = 'active'`,
    [host]
  );
  const row = r.rows[0];
  if (!row) return null;
  const settings = settingsOf(row["settings"]);
  const logo = numOrNull(row["logo_light_id"]), fav = numOrNull(row["favicon_id"]);
  settings.brand.logoLight = logo;
  settings.brand.favicon = fav;
  return { id: String(row["id"]), settings, logoLightId: logo, faviconId: fav };
}
