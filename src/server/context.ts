import { randomUUID } from "node:crypto";
import pg from "pg";
import { getRequiredDisclosureKeys } from "../config/disclosures";
import type { EnquiryDeps } from "../domain/enquiry-service";
import type { Actor, ListingServiceDeps } from "../domain/listing-service";
import { actorFromRequest } from "./auth/actor";
import { readAuthEnv } from "./auth/config";
import { appendAuditPg, createPgListingRepository, type Queryable } from "./db";
import { createPgEnquiryRepository, getBuyerVerification } from "./enquiry-db";

interface Wired { db: Queryable; deps: ListingServiceDeps; enquiryDeps: EnquiryDeps }
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
  const repo = createPgListingRepository(db);
  const appendAudit = (e: Parameters<typeof appendAuditPg>[1]) => appendAuditPg(db, e);
  const now = () => new Date().toISOString();
  const newId = () => randomUUID();
  return {
    db,
    deps: { repo, appendAudit, now, newId, requiredDisclosures: getRequiredDisclosureKeys },
    enquiryDeps: {
      enquiries: createPgEnquiryRepository(db),
      listings: repo,
      verification: id => getBuyerVerification(db, id),
      appendAudit, now, newId
    }
  };
}

function wired(): Wired {
  g.__ownerlisting ??= wire();
  return g.__ownerlisting;
}

export const getDeps = () => wired().deps;
export const getDb = () => wired().db;
export const getEnquiryDeps = () => wired().enquiryDeps;

export function getActor(req: Request): Actor | null {
  const auth = readAuthEnv();
  return auth ? actorFromRequest(req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}
