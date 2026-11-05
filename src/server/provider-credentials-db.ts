import { openOfferToken, sealOfferToken } from "../domain/offer-link-crypto";
import { mfaKeyUsable } from "../domain/mfa";
import type { DomainConfig } from "../adapters/feed-providers";
import { domainConfig } from "../adapters/feed-providers";
import { appendAuditPg, type Queryable } from "./db";
import { randomUUID } from "node:crypto";

/**
 * Provider credentials that staff enter in the admin screen. The secret is sealed with PROVIDER_CREDENTIAL_KEY
 * (or MFA_SECRET_KEY when that is not set; both are base64 of 32 bytes). No usable key = nothing is stored or read (fails closed).
 * The secret is never returned to the browser, written to the audit log or put in an error message.
 */
export type CredentialProvider = "domain";
type Env = Record<string, string | undefined>;

export const credentialKey = (env: Env): string | undefined => {
  const k = env["PROVIDER_CREDENTIAL_KEY"]?.trim() || env["MFA_SECRET_KEY"]?.trim();
  return mfaKeyUsable(k) ? k : undefined;
};
const aad = (p: CredentialProvider) => `provider-credential:${p}`;

export interface CredentialStatus {
  source: "stored" | "environment" | "none";
  clientId: string | null;
  /** Last 4 characters of the client id only, for display. */
  clientIdHint: string | null;
  lastTestedAt: string | null; lastTestOk: boolean | null; lastTestError: string | null;
  updatedAt: string | null; canStore: boolean;
}

export const maskId = (id: string) => (id.length <= 4 ? "••••" : `••••${id.slice(-4)}`);

/** Normalises what staff typed: trims, one line, no spaces, bounded length. */
export function parseDomainCredentials(body: unknown): { ok: true; clientId: string; clientSecret: string } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const clientId = typeof b["clientId"] === "string" ? b["clientId"].trim() : "";
  const clientSecret = typeof b["clientSecret"] === "string" ? b["clientSecret"].trim() : "";
  if (!clientId || !clientSecret) return { ok: false, error: "Enter both the client ID and the client secret." };
  if (clientId.length > 200 || clientSecret.length > 500) return { ok: false, error: "That value is too long." };
  if (/\s/.test(clientId) || /\s/.test(clientSecret)) return { ok: false, error: "The client ID and secret must not contain spaces or line breaks." };
  return { ok: true, clientId, clientSecret };
}

export async function getCredentialStatus(db: Queryable, provider: CredentialProvider, env: Env): Promise<CredentialStatus> {
  const canStore = credentialKey(env) !== undefined;
  const r = await db.query("SELECT client_id, last_tested_at, last_test_ok, last_test_error, updated_at FROM provider_credential WHERE provider = $1", [provider]);
  const row = r.rows[0];
  if (row) {
    const id = String(row["client_id"]);
    return {
      source: "stored", clientId: null, clientIdHint: maskId(id), canStore,
      lastTestedAt: row["last_tested_at"] ? new Date(String(row["last_tested_at"])).toISOString() : null,
      lastTestOk: row["last_test_ok"] === null || row["last_test_ok"] === undefined ? null : Boolean(row["last_test_ok"]),
      lastTestError: row["last_test_error"] ? String(row["last_test_error"]) : null,
      updatedAt: new Date(String(row["updated_at"])).toISOString()
    };
  }
  const envCfg = domainConfig(env);
  return { source: envCfg ? "environment" : "none", clientId: null, clientIdHint: envCfg ? maskId(envCfg.clientId) : null, lastTestedAt: null, lastTestOk: null, lastTestError: null, updatedAt: null, canStore };
}

export async function saveDomainCredentials(db: Queryable, staffId: string, clientId: string, clientSecret: string, env: Env, now: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = credentialKey(env);
  if (!key) return { ok: false, error: "Storing keys is not available: set PROVIDER_CREDENTIAL_KEY (or MFA_SECRET_KEY) on the server first." };
  const sealed = await sealOfferToken(clientSecret, key, aad("domain"));
  await db.query(
    `INSERT INTO provider_credential (provider, client_id, secret_sealed, updated_by, updated_at) VALUES ('domain', $1, $2, $3, $4)
     ON CONFLICT (provider) DO UPDATE SET client_id = $1, secret_sealed = $2, updated_by = $3, updated_at = $4,
       last_tested_at = NULL, last_test_ok = NULL, last_test_error = NULL`,
    [clientId, sealed, staffId, now]
  );
  await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staffId, aggregateType: "provider_credential", aggregateId: "domain",
    eventType: "provider_credential.saved", correlationId: randomUUID(), payload: { provider: "domain", clientIdHint: maskId(clientId) } });
  return { ok: true };
}

export async function deleteDomainCredentials(db: Queryable, staffId: string, now: string): Promise<boolean> {
  const r = await db.query("DELETE FROM provider_credential WHERE provider = 'domain' RETURNING provider", []);
  if (!r.rows[0]) return false;
  await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staffId, aggregateType: "provider_credential", aggregateId: "domain",
    eventType: "provider_credential.removed", correlationId: randomUUID(), payload: { provider: "domain" } });
  return true;
}

export async function recordTestResult(db: Queryable, provider: CredentialProvider, ok: boolean, error: string | null, now: string): Promise<void> {
  await db.query("UPDATE provider_credential SET last_tested_at = $2, last_test_ok = $3, last_test_error = $4 WHERE provider = $1", [provider, now, ok, error?.slice(0, 300) ?? null]);
}

/** The Domain config to use: the stored one when present (and readable), else the environment's. Never throws. */
export async function resolveDomainConfig(db: Queryable, env: Env): Promise<DomainConfig | null> {
  try {
    const r = await db.query("SELECT client_id, secret_sealed FROM provider_credential WHERE provider = 'domain'", []);
    const row = r.rows[0];
    if (row) {
      const key = credentialKey(env);
      const secret = key ? await openOfferToken(String(row["secret_sealed"]), key, aad("domain")).catch(() => undefined) : undefined;
      if (secret) return domainConfig({ DOMAIN_CLIENT_ID: String(row["client_id"]), DOMAIN_CLIENT_SECRET: secret });
      return null; // stored but unreadable (key changed): the connector is off rather than silently using other keys
    }
  } catch { /* table missing or database error: fall back to the environment */ }
  return domainConfig(env);
}

/** The environment a feed run should see: stored Domain keys, when present, replace DOMAIN_CLIENT_ID/SECRET. */
export async function envWithStoredDomain(db: Queryable, env: Env): Promise<Env> {
  const c = await resolveDomainConfig(db, env);
  const { DOMAIN_CLIENT_ID: _a, DOMAIN_CLIENT_SECRET: _b, ...rest } = env;
  return c ? { ...rest, DOMAIN_CLIENT_ID: c.clientId, DOMAIN_CLIENT_SECRET: c.clientSecret } : rest;
}
