import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteDomainCredentials, envWithStoredDomain, getCredentialStatus, recordTestResult, resolveDomainConfig, saveDomainCredentials
} from "../src/server/provider-credentials-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const KEY = Buffer.alloc(32, 9).toString("base64");
const NOW = "2026-11-05T00:00:00.000Z";

describe.skipIf(!DATABASE_URL)("provider credentials on PostgreSQL", () => {
  let t: TestDb; let staff: string;
  beforeAll(async () => {
    t = await createTestDb();
    staff = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,'S','owner','active') RETURNING id", [`${randomUUID()}@t.au`])).rows[0]!["id"]);
  });
  afterAll(async () => { await t?.close(); });

  it("stores the secret sealed, resolves it, never returns it in status, and falls back to the environment", async () => {
    const env = { MFA_SECRET_KEY: KEY, DOMAIN_CLIENT_ID: "env_id", DOMAIN_CLIENT_SECRET: "env_secret" };
    expect((await getCredentialStatus(t.db, "domain", env)).source).toBe("environment");
    expect(await saveDomainCredentials(t.db, staff, "stored_id_1234", "stored_secret", env, NOW)).toEqual({ ok: true });
    const raw = String((await t.db.query("SELECT secret_sealed FROM provider_credential WHERE provider='domain'", [])).rows[0]!["secret_sealed"]);
    expect(raw.startsWith("v1.")).toBe(true);
    expect(raw).not.toContain("stored_secret");
    expect(await resolveDomainConfig(t.db, env)).toMatchObject({ clientId: "stored_id_1234", clientSecret: "stored_secret" });
    expect((await envWithStoredDomain(t.db, env))["DOMAIN_CLIENT_SECRET"]).toBe("stored_secret");
    await recordTestResult(t.db, "domain", false, "Domain refused the client id or secret.", NOW);
    const st = await getCredentialStatus(t.db, "domain", env);
    expect(st).toMatchObject({ source: "stored", clientIdHint: "••••1234", lastTestOk: false });
    expect(JSON.stringify(st)).not.toContain("stored_secret");
    const audit = JSON.stringify((await t.db.query("SELECT event_type, payload FROM audit_event WHERE aggregate_type='provider_credential'", [])).rows);
    expect(audit).toContain("provider_credential.saved");
    expect(audit).not.toContain("stored_secret");
  });

  it("is off (not the environment's keys) when stored keys cannot be opened with the current key", async () => {
    const env = { MFA_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"), DOMAIN_CLIENT_ID: "env_id", DOMAIN_CLIENT_SECRET: "env_secret" };
    expect(await resolveDomainConfig(t.db, env)).toBeNull();
  });

  it("refuses to store without a usable key, and disconnect restores the environment fallback", async () => {
    expect((await saveDomainCredentials(t.db, staff, "a", "b", {}, NOW)).ok).toBe(false);
    const env = { MFA_SECRET_KEY: KEY, DOMAIN_CLIENT_ID: "env_id", DOMAIN_CLIENT_SECRET: "env_secret" };
    expect(await deleteDomainCredentials(t.db, staff, NOW)).toBe(true);
    expect(await deleteDomainCredentials(t.db, staff, NOW)).toBe(false);
    expect(await resolveDomainConfig(t.db, env)).toMatchObject({ clientId: "env_id" });
  });
});
