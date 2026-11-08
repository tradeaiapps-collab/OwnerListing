import type { Queryable } from "../db";
import { PROVIDER_IDS, type ProviderId } from "./errors";
import type { ProviderEventInput, ProviderEventStore } from "./webhook";

export function createPgEventStore(db: Queryable): ProviderEventStore {
  return {
    async record(e: ProviderEventInput) {
      const r = await db.query(
        `INSERT INTO provider_events (provider, event_id, event_type, payload, body_sha256) VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [e.provider, e.eventId, e.eventType, JSON.stringify(e.payload), e.bodySha256]
      );
      return r.rows[0] ? { inserted: true, id: r.rows[0]["id"] as string } : { inserted: false };
    },
    async finish(id, status, error) {
      await db.query("UPDATE provider_events SET process_status=$2, process_error=$3, processed_at=now() WHERE id=$1", [id, status, error?.slice(0, 500) ?? null]);
    }
  };
}

const cut = (s: string | undefined, n: number) => s?.slice(0, n) ?? null;

/** Sync run log: start a row, then finish it as success or error. Error text is capped and must not hold secrets. */
export async function startSync(db: Queryable, provider: ProviderId, kind: string, opts: { credentialId?: string; correlationId?: string } = {}): Promise<string> {
  const r = await db.query("INSERT INTO provider_sync_logs (provider, kind, credential_id, correlation_id) VALUES ($1,$2,$3,$4) RETURNING id", [provider, kind, opts.credentialId ?? null, opts.correlationId ?? null]);
  return r.rows[0]!["id"] as string;
}
export async function finishSync(db: Queryable, id: string, r: { seen?: number; changed?: number; errorCode?: string; errorMessage?: string }): Promise<void> {
  await db.query(
    "UPDATE provider_sync_logs SET status=$2, records_seen=$3, records_changed=$4, error_code=$5, error_message=$6, finished_at=now() WHERE id=$1 AND status='running'",
    [id, r.errorCode ? "error" : "success", r.seen ?? 0, r.changed ?? 0, cut(r.errorCode, 60), cut(r.errorMessage, 500)]
  );
}

export interface LastSync { provider: ProviderId; status: string; startedAt: string; finishedAt: string | null; errorCode: string | null }
/** Most recent sync run per provider (for the health report). */
export async function lastSyncs(db: Queryable): Promise<LastSync[]> {
  const r = await db.query(
    `SELECT DISTINCT ON (provider) provider, status, started_at, finished_at, error_code FROM provider_sync_logs
     WHERE provider = ANY($1::text[]) ORDER BY provider, started_at DESC`, [[...PROVIDER_IDS]]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return r.rows.map(x => ({ provider: x["provider"] as ProviderId, status: x["status"] as string, startedAt: iso(x["started_at"]), finishedAt: x["finished_at"] ? iso(x["finished_at"]) : null, errorCode: (x["error_code"] as string | null) ?? null }));
}

/** Connect (or replace) a provider for an agent/owner or a team. The secret arrives already sealed (seal.ts). */
export async function connectCredential(db: Queryable, a: { provider: ProviderId; ownerUserId?: string; teamId?: string; externalAccountId?: string; secretSealed?: string }): Promise<string> {
  if (!a.ownerUserId === !a.teamId) throw new Error("Give exactly one of ownerUserId or teamId.");
  const run = async (q: Queryable) => {
    const col = a.ownerUserId ? "owner_user_id" : "team_id";
    await q.query(`UPDATE provider_credentials SET status='revoked', revoked_at=now() WHERE provider=$1 AND ${col}=$2 AND status<>'revoked'`, [a.provider, a.ownerUserId ?? a.teamId]);
    const r = await q.query("INSERT INTO provider_credentials (provider, owner_user_id, team_id, external_account_id, secret_sealed) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [a.provider, a.ownerUserId ?? null, a.teamId ?? null, a.externalAccountId ?? null, a.secretSealed ?? null]);
    return r.rows[0]!["id"] as string;
  };
  return db.transaction ? db.transaction(run) : run(db);
}
export async function revokeCredential(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query("UPDATE provider_credentials SET status='revoked', revoked_at=now(), secret_sealed=NULL WHERE id=$1 AND status<>'revoked' RETURNING id", [id]);
  return r.rows.length > 0;
}
