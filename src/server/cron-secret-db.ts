import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./db";

/** Scheduled jobs that call an internal endpoint with header x-cron-secret. */
export const CRON_JOBS = {
  automations: { label: "Automation runs", envVar: "AUTOMATION_CRON_SECRET", schedule: "Every 10 minutes", workflow: "automation-runs.yml", repoSecret: "AUTOMATION_CRON_SECRET" },
  staff_automation: { label: "Staff automation and campaigns", envVar: "STAFF_AUTOMATION_CRON_SECRET", schedule: "Every 15 minutes", workflow: "staff-automation.yml", repoSecret: "STAFF_AUTOMATION_CRON_SECRET" },
  disputes: { label: "Dispute escalation", envVar: "DISPUTES_CRON_SECRET", schedule: "Hourly", workflow: "dispute-escalation.yml", repoSecret: "DISPUTES_CRON_SECRET" }
} as const;
export type CronJob = keyof typeof CRON_JOBS;
export const CRON_JOB_KEYS = Object.keys(CRON_JOBS) as CronJob[];
export const isCronJob = (v: unknown): v is CronJob => typeof v === "string" && (CRON_JOB_KEYS as string[]).includes(v);
export const MIN_SECRET_LENGTH = 32;

export const generateCronSecret = () => randomBytes(32).toString("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest();
const hashHex = (s: string) => sha256(s).toString("hex");
const sameDigest = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

interface Row { secretHash: string | null; last4: string | null; enabled: boolean; rotatedAt: string | null; lastCalledAt: string | null }

async function loadRow(db: Queryable, job: CronJob): Promise<Row | null> {
  const r = (await db.query(`SELECT secret_hash, secret_last4, enabled, rotated_at, last_called_at FROM cron_secret_setting WHERE job = $1`, [job])).rows[0];
  if (!r) return null;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return { secretHash: r["secret_hash"] ? String(r["secret_hash"]) : null, last4: r["secret_last4"] ? String(r["secret_last4"]) : null, enabled: r["enabled"] !== false, rotatedAt: iso(r["rotated_at"]), lastCalledAt: iso(r["last_called_at"]) };
}

export type CronAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * Decides whether a cron call may run. A stored secret (set in the admin console) wins over the environment variable; the variable is used only while none is stored.
 * FAILS CLOSED: 503 while the job is switched off, has no secret anywhere, or the database cannot be read and no usable environment secret exists; 401 on any mismatch.
 */
export async function authorizeCron(db: Queryable, job: CronJob, header: string | null, env: Record<string, string | undefined> = process.env): Promise<CronAuth> {
  let row: Row | null = null;
  try { row = await loadRow(db, job); } catch { row = null; }
  if (row && !row.enabled) return { ok: false, status: 503, error: "This scheduled job is paused." };
  const envSecret = env[CRON_JOBS[job].envVar];
  const supplied = header ?? "";
  if (row?.secretHash) {
    if (supplied.length > 0 && sameDigest(hashHex(supplied), row.secretHash)) { await touch(db, job); return { ok: true }; }
    return { ok: false, status: 401, error: "Not allowed." };
  }
  if (!envSecret || envSecret.length < MIN_SECRET_LENGTH) return { ok: false, status: 503, error: "Not configured." };
  if (!sameDigest(supplied, envSecret)) return { ok: false, status: 401, error: "Not allowed." };
  await touch(db, job);
  return { ok: true };
}

async function touch(db: Queryable, job: CronJob): Promise<void> {
  try { await db.query(`UPDATE cron_secret_setting SET last_called_at = now() WHERE job = $1`, [job]); } catch { /* bookkeeping only */ }
}

export interface CronStatus {
  job: CronJob; label: string; schedule: string; workflow: string; repoSecret: string; envVar: string;
  /** Where the secret in force comes from. */
  source: "database" | "environment" | "none";
  enabled: boolean;
  /** True when the job will accept a correctly signed call right now. */
  active: boolean;
  /** Last four characters of a stored secret; the rest is never kept. */
  last4: string | null;
  rotatedAt: string | null;
  lastCalledAt: string | null;
  envFallbackSet: boolean;
}

export async function cronStatus(db: Queryable, job: CronJob, env: Record<string, string | undefined> = process.env): Promise<CronStatus> {
  const row = await loadRow(db, job);
  const envOk = (env[CRON_JOBS[job].envVar] ?? "").length >= MIN_SECRET_LENGTH;
  const source = row?.secretHash ? "database" : envOk ? "environment" : "none";
  const enabled = row?.enabled ?? true;
  return { job, ...CRON_JOBS[job], source, enabled, active: enabled && source !== "none", last4: row?.last4 ?? null, rotatedAt: row?.rotatedAt ?? null, lastCalledAt: row?.lastCalledAt ?? null, envFallbackSet: envOk };
}

export const allCronStatus = (db: Queryable, env: Record<string, string | undefined> = process.env) => Promise.all(CRON_JOB_KEYS.map(j => cronStatus(db, j, env)));

/** Stores a new random secret (hash only) and returns the plain value once. The old secret stops working at once. */
export async function rotateCronSecret(db: Queryable, job: CronJob, staffId: string): Promise<string> {
  const secret = generateCronSecret();
  await db.query(
    `INSERT INTO cron_secret_setting (job, secret_hash, secret_last4, rotated_at, updated_by, updated_at) VALUES ($1, $2, $3, now(), $4, now())
     ON CONFLICT (job) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, secret_last4 = EXCLUDED.secret_last4, rotated_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [job, hashHex(secret), secret.slice(-4), staffId]
  );
  return secret;
}

export async function setCronEnabled(db: Queryable, job: CronJob, staffId: string, enabled: boolean): Promise<void> {
  await db.query(
    `INSERT INTO cron_secret_setting (job, enabled, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (job) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [job, enabled, staffId]
  );
}
