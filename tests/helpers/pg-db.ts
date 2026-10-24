import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Queryable } from "../../src/server/db";

/** Real-Postgres tests run only when DATABASE_URL is set (CI provides it). */
export const DATABASE_URL = process.env["DATABASE_URL"];

const dbDir = path.join(process.cwd(), "db");

/** Same logic as scripts/migrate.mjs: db/*.sql in filename order, once each, each in its own transaction. */
export async function migrateAll(client: pg.PoolClient): Promise<string[]> {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await client.query("SELECT name FROM schema_migration")).rows.map(r => r.name as string));
  const files = (await readdir(dbDir)).filter(f => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(path.join(dbDir, f), "utf8"));
      await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      applied.push(f);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return applied;
}

export interface TestDb { db: Queryable; pool: pg.Pool; applied: string[]; close(): Promise<void> }

/** Creates a throwaway database on DATABASE_URL's server, applies every migration to it, and drops it on close. */
export async function createTestDb(): Promise<TestDb> {
  const base = new URL(DATABASE_URL!);
  const name = `ol_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  base.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: base.toString(), max: 5 });
  const mig = await pool.connect();
  let applied: string[];
  try {
    applied = await migrateAll(mig);
  } finally {
    mig.release();
  }
  const wrap = (q: { query(t: string, p?: unknown[]): Promise<pg.QueryResult> }): Pick<Queryable, "query"> => ({
    async query(text, params) { return { rows: (await q.query(text, params)).rows as Record<string, unknown>[] }; }
  });
  const db: Queryable = {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }
  };
  return {
    db, pool, applied,
    async close() {
      await pool.end();
      const a = new pg.Client({ connectionString: DATABASE_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    }
  };
}

/** Inserts a user and returns its id. */
export async function addUser(db: Queryable, type: "owner" | "buyer" | "admin" | "agent", status = "active"): Promise<string> {
  const r = await db.query(
    "INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,$4) RETURNING id",
    [`${randomUUID()}@example.test`, `Test ${type}`, type, status]
  );
  return String(r.rows[0]!["id"]);
}

/** Inserts a listing with the given overrides and returns its id. */
export async function addListing(db: Queryable, ownerId: string, o: Record<string, unknown> = {}): Promise<string> {
  const v = { jurisdiction: "NSW", transaction_type: "sale", use_class: "residential", property_type: "house", title: "Home", address_text: "1 Test St",
    status: "draft", suburb: null, postcode: null, price_cents: null, bedrooms: null, bathrooms: null, parking: null, created_at: new Date().toISOString(), ...o };
  const r = await db.query(
    `INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, status, suburb, postcode, price_cents, bedrooms, bathrooms, parking, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [ownerId, v.jurisdiction, v.transaction_type, v.use_class, v.property_type, v.title, v.address_text, v.status, v.suburb, v.postcode, v.price_cents, v.bedrooms, v.bathrooms, v.parking, v.created_at]
  );
  return String(r.rows[0]!["id"]);
}
