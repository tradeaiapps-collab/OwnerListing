import type { PageRenderer } from "../domain/project-document-masking";
import { imageSanitiserFromEnv, type ImageSanitiserPort } from "../adapters/image-sanitiser";
import { imageVariantsFromEnv, type ImageVariantPort } from "../adapters/image-variants";
import { malwareScannerFromEnv } from "../adapters/malware-scan";
import { objectStorageFromEnv } from "../adapters/object-storage";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Actor, ListingServiceDeps } from "../domain/listing-service";
import { actorFromRequestChecked } from "./auth/actor";
import { readSessionEnv } from "./auth/config";
import type { StaffActor } from "../domain/staff-access";
import { createPgBillingStore } from "./billing-db";
import { staffFromRequest } from "./staff-auth";
import { createPgPublishAlertHook } from "./publish-alerts-db";
import { syndicateListing, syndicationDeps } from "./syndication-db";
import { hasCurrentTermsPg } from "./terms-db";
import { elenaPhotoFactsPg, queueForModerationPg } from "./elena-review-db";
import { clearedWordingFlagsPg, recordWordingFlagsPg } from "./wording-flags-db";
import { disclosureRequirementsPg, markListingDisclosureVersionPg } from "./disclosure-config-db";
import { appendAuditPg, appointmentForPg, createPgListingRepository, trustAccountDecisionPg, verifiedLicencesPg, type Queryable } from "./db";

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
    },
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Queryable = {
        async query(text, params) {
          const r = await client.query(text, params);
          return { rows: r.rows as Record<string, unknown>[] };
        }
      };
      try {
        await client.query("BEGIN");
        const out = await fn(tx);
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
    db,
    deps: {
      repo: createPgListingRepository(db),
      licences: () => verifiedLicencesPg(db),
      appendAudit: e => appendAuditPg(db, e),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      // Superseded by disclosureRequirements (database, Compliance-approved versions); kept closed as a backstop.
      requiredDisclosures: () => null,
      disclosureRequirements: listing => disclosureRequirementsPg(db, listing),
      markDisclosureVersion: (listingId, versionId) => markListingDisclosureVersionPg(db, listingId, versionId),
      appointmentFor: (listingId, agentUserId) => appointmentForPg(db, listingId, agentUserId),
      trustAccountFor: listingId => trustAccountDecisionPg(db, listingId),
      termsCurrentFor: userId => hasCurrentTermsPg(db, userId, new Date().toISOString()),
      afterPublish: (() => {
        const alerts = createPgPublishAlertHook(db);
        // Share on the portals the owner opted into; best effort, the scheduled run retries anything that fails.
        return async (listing: Parameters<typeof alerts>[0]) => { await alerts(listing); await syndicateListing(db, syndicationDeps(), listing.id); };
      })(),
      elenaFacts: listingId => elenaPhotoFactsPg(db, listingId),
      queueForModeration: (listing, review, actorUserId) => queueForModerationPg(db, listing.id, review, actorUserId),
      clearedWordingFlags: listingId => clearedWordingFlagsPg(db, listingId),
      recordWordingFlags: (listingId, actorUserId, fields) => recordWordingFlagsPg(db, listingId, actorUserId, fields)
    }
  };
}

function wired(): Wired {
  g.__ownerlisting ??= wire();
  return g.__ownerlisting;
}

export const getDeps = () => wired().deps;
export const getDb = () => wired().db;
export const getBilling = () => createPgBillingStore(getDb());

/** Signed-in staff member (role read from the database now), or null. */
export async function getStaff(req: Request): Promise<StaffActor | null> {
  const auth = readSessionEnv();
  return auth ? staffFromRequest(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}

/** Signed-in owner/agent/buyer, confirmed against the database now (exists, active, same type as the cookie), or null. */
export async function getActor(req: Request): Promise<Actor | null> {
  const auth = readSessionEnv();
  return auth ? actorFromRequestChecked(getDb(), req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}

/** File storage and malware scanner. Both fail closed (uploads refused) until real providers are configured. */
export function getUploadPorts() {
  return { storage: objectStorageFromEnv(process.env), scanner: malwareScannerFromEnv(process.env) };
}

/** Storage plus the server-side page renderer used to show investor project documents in the site. */
export function getMaskPorts() {
  // Loaded on first use: pdf.js and the canvas library are heavy native code that no other page needs.
  const load = async () => (await import("./pdf-pages")).createPageRenderer();
  const renderer: PageRenderer = { async analyse(b, m) { return (await load()).analyse(b, m); }, async render(b, m, p, o) { return (await load()).render(b, m, p, o); } };
  return { storage: objectStorageFromEnv(process.env), renderer };
}

let variants: Promise<ImageVariantPort> | undefined;
let sanitiser: Promise<ImageSanitiserPort> | undefined;
/** Upload ports plus the optional resizer for listing photos (smaller copies only when the image library is installed). */
export async function getPhotoPorts() {
  variants ??= imageVariantsFromEnv(process.env);
  sanitiser ??= imageSanitiserFromEnv(process.env);
  return { ...getUploadPorts(), variants: await variants, sanitiser: await sanitiser };
}
