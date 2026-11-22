import { randomUUID } from "node:crypto";
import { milestoneFor, reminderText, type CertKind, type Milestone } from "../domain/contractor-certificates";
import { todayUtc } from "../domain/contractor-trust";
import { notSuspendedSql } from "./contractor-standing-sql";
import { appendAuditPg, type Queryable } from "./db";
import { notifyUser } from "./notifier";

/**
 * Contractor certificate storage and the expiry reminder job. Constant SQL, bound parameters only. The acting user id comes from the session.
 * Nothing is deleted: a newer upload of the same kind marks the older one superseded. Storage keys and fingerprints are never selected for display.
 */
const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));
const dateStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface CertificateRow { id: string; kind: CertKind; expiry: string; mime: string; sizeBytes: number; uploadedAt: string }
const toRow = (r: Record<string, unknown>): CertificateRow => ({ id: String(r["id"]), kind: String(r["kind"]) as CertKind, expiry: dateStr(r["expiry_date"]), mime: String(r["declared_mime"]), sizeBytes: Number(r["size_bytes"]), uploadedAt: iso(r["uploaded_at"]) });
const COLS = "id, kind, expiry_date, declared_mime, size_bytes, uploaded_at";

/** The contractor's current certificates (one per kind). */
export async function listCertificatesPg(db: Queryable, userId: string): Promise<CertificateRow[]> {
  return (await db.query(`SELECT ${COLS} FROM contractor_certificate WHERE user_id = $1::uuid AND status = 'active' ORDER BY kind`, [userId])).rows.map(toRow);
}

/** Current certificates for many contractors at once (staff queue, badge). */
export async function currentCertificatesPg(db: Queryable, userIds: readonly string[]): Promise<Map<string, CertificateRow[]>> {
  const out = new Map<string, CertificateRow[]>();
  if (userIds.length === 0) return out;
  for (const r of (await db.query(`SELECT user_id, ${COLS} FROM contractor_certificate WHERE user_id = ANY($1::uuid[]) AND status = 'active'`, [userIds])).rows) {
    const k = String(r["user_id"]);
    out.set(k, [...(out.get(k) ?? []), toRow(r)]);
  }
  return out;
}
export const certDates = (rows: readonly CertificateRow[] | undefined): Partial<Record<CertKind, string>> => Object.fromEntries((rows ?? []).map(c => [c.kind, c.expiry]));

/** Uploads in the last 24 hours (for the daily limit). */
export async function countRecentCertificatesPg(db: Queryable, userId: string, sinceIso: string): Promise<number> {
  return Number((await db.query("SELECT count(*)::int AS n FROM contractor_certificate WHERE user_id = $1::uuid AND uploaded_at >= $2::timestamptz", [userId, sinceIso])).rows[0]?.["n"] ?? 0);
}

/** Stores the record and supersedes the earlier current one of that kind, in one transaction. False when the account is not an active contractor. */
export async function addCertificatePg(db: Queryable, c: { userId: string; kind: CertKind; storageKey: string; sha256: string; mime: string; sizeBytes: number; expiry: string }): Promise<string | undefined> {
  return inTx(db, async tx => {
    const who = await tx.query("SELECT 1 FROM app_user WHERE id = $1::uuid AND user_type IN ('vendor', 'agent') AND status NOT IN ('suspended', 'closed') FOR UPDATE", [c.userId]);
    if (who.rows.length !== 1) return undefined;
    await tx.query("UPDATE contractor_certificate SET status = 'superseded' WHERE user_id = $1::uuid AND kind = $2 AND status = 'active'", [c.userId, c.kind]);
    const id = randomUUID();
    await tx.query(
      "INSERT INTO contractor_certificate (id, user_id, kind, storage_key, sha256, declared_mime, size_bytes, expiry_date) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date)",
      [id, c.userId, c.kind, c.storageKey, c.sha256, c.mime, c.sizeBytes, c.expiry]);
    await appendAuditPg(tx, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: c.userId, aggregateType: "contractor_certificate", aggregateId: id, eventType: "contractor_certificate.uploaded", correlationId: randomUUID(), payload: { kind: c.kind } });
    return id;
  });
}

/** The stored file for one certificate, for its owner or (staff route) anyone who passed the staff gate. `ownerId` null skips the owner check. */
export async function certificateFilePg(db: Queryable, id: string, ownerId: string | null): Promise<{ storageKey: string; contentType: string } | undefined> {
  const r = (await db.query("SELECT storage_key, declared_mime FROM contractor_certificate WHERE id = $1::uuid AND ($2::uuid IS NULL OR user_id = $2::uuid)", [id, ownerId])).rows[0];
  return r ? { storageKey: String(r["storage_key"]), contentType: String(r["declared_mime"]) } : undefined;
}

export interface ExpiryRunResult { checked: number; sent: number }
/**
 * Daily reminder job (called from the automations tick, safe to call every tick). For each staff-verified, active contractor and each of insurance and
 * licence, at most one email per step (30 days, 7 days, expired) per expiry date: the notice row is inserted first and the email goes only for a
 * newly inserted row, so a repeat tick or a second server sends nothing twice. A missed day sends the step that applies now, not the earlier ones.
 */
export async function runCertificateExpiryNotices(db: Queryable, now: string, limit = 500): Promise<ExpiryRunResult> {
  const today = todayUtc(new Date(now));
  const due = (await db.query(
    `SELECT v.user_id, k.kind, k.expiry FROM contractor_verification v JOIN app_user u ON u.id = v.user_id
     CROSS JOIN LATERAL (VALUES ('insurance', v.insurance_expiry), ('licence', v.licence_expiry)) AS k(kind, expiry)
     WHERE v.status = 'verified' AND k.expiry IS NOT NULL AND k.expiry <= $1::date + 30 AND u.status NOT IN ('suspended', 'closed') AND ${notSuspendedSql("v.user_id")}
       AND NOT EXISTS (SELECT 1 FROM contractor_expiry_notice n WHERE n.user_id = v.user_id AND n.kind = k.kind AND n.expiry_date = k.expiry AND n.milestone = 0)
     ORDER BY k.expiry LIMIT $2::int`, [today, limit])).rows;
  let sent = 0;
  for (const r of due) {
    const kind = String(r["kind"]) as CertKind, expiry = dateStr(r["expiry"]), userId = String(r["user_id"]);
    const milestone: Milestone | null = milestoneFor(expiry, today);
    if (milestone === null) continue;
    try {
      const ins = await db.query(
        "INSERT INTO contractor_expiry_notice (user_id, kind, expiry_date, milestone) VALUES ($1::uuid, $2, $3::date, $4::int) ON CONFLICT DO NOTHING RETURNING user_id", [userId, kind, expiry, milestone]);
      if (ins.rows.length !== 1) continue;
      const t = reminderText(kind, expiry, milestone);
      await notifyUser(db, userId, milestone === 0 ? "cert_expired" : "cert_expiring", { title: t.title, text: t.text, link: "/contractor/trust" });
      sent++;
    } catch { /* one contractor's failure never stops the run */ }
  }
  return { checked: due.length, sent };
}
