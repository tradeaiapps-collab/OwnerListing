import { randomUUID } from "node:crypto";
import pg from "pg";
import { getRequiredDisclosureKeys } from "../config/disclosures";
import type { Actor, ListingServiceDeps } from "../domain/listing-service";
import { actorFromRequest } from "./auth/actor";
import { readAuthEnv } from "./auth/config";
import { appendAuditPg, createPgListingRepository, verifiedLicencesPg, type Queryable } from "./db";

interface Wired { db: Queryable; deps: ListingServiceDeps }
const g = globalThis as unknown as { __ownerlisting?: Wired };

function wire(): Wired {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db: Queryable = {
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows as Record<string, unknown>[] };
    }
  };
  return {
    db,
    deps: {
      repo: createPgListingRepository(db),
      licences: () => verifiedLicencesPg(db),
      appendAudit: e => appendAuditPg(db, e),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      requiredDisclosures: getRequiredDisclosureKeys
    }
  };
}

function wired(): Wired {
  g.__ownerlisting ??= wire();
  return g.__ownerlisting;
}

export const getDeps = () => wired().deps;
export const getDb = () => wired().db;

export function getActor(req: Request): Actor | null {
  const auth = readAuthEnv();
  return auth ? actorFromRequest(req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}
