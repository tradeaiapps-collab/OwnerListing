import { malwareScannerFromEnv } from "../adapters/malware-scan";
import { objectStorageFromEnv } from "../adapters/object-storage";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getRequiredDisclosureKeys } from "../config/disclosures";
import type { Actor, ListingServiceDeps } from "../domain/listing-service";
import { actorFromRequest } from "./auth/actor";
import { readAuthEnv } from "./auth/config";
import type { StaffActor } from "../domain/staff-access";
import { staffFromRequest } from "./staff-auth";
import { appendAuditPg, appointmentForPg, createPgListingRepository, verifiedLicencesPg, type Queryable } from "./db";

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
      requiredDisclosures: getRequiredDisclosureKeys,
      appointmentFor: (listingId, agentUserId) => appointmentForPg(db, listingId, agentUserId)
    }
  };
}

function wired(): Wired {
  g.__ownerlisting ??= wire();
  return g.__ownerlisting;
}

export const getDeps = () => wired().deps;
export const getDb = () => wired().db;

/** Signed-in staff member (role read from the database now), or null. */
export async function getStaff(req: Request): Promise<StaffActor | null> {
  const auth = readAuthEnv();
  return auth ? staffFromRequest(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}

export function getActor(req: Request): Actor | null {
  const auth = readAuthEnv();
  return auth ? actorFromRequest(req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}

/** File storage and malware scanner. Both fail closed (uploads refused) until real providers are configured. */
export function getUploadPorts() {
  return { storage: objectStorageFromEnv(process.env), scanner: malwareScannerFromEnv(process.env) };
}
