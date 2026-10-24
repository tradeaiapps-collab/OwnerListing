import { randomUUID } from "node:crypto";
import pg from "pg";
import { getRequiredDisclosureKeys } from "../config/disclosures";
import type { EnquiryDeps } from "../domain/enquiry-service";
import { issueOfferLink, type OfferDeps } from "../domain/offer-service";
import type { Actor, ListingServiceDeps } from "../domain/listing-service";
import { actorFromRequest } from "./auth/actor";
import { readAuthEnv } from "./auth/config";
import { appendAuditPg, createPgListingRepository, type Queryable } from "./db";
import { createPgEnquiryRepository, getBuyerVerification } from "./enquiry-db";
import { createPgOfferRepository } from "./offer-db";
import type { IdDeps } from "../domain/id-review-service";
import { createPgIdRepository, fileStoreFromEnv, staffFor } from "./id-db";
import type { PhoneDeps } from "../domain/phone-verification";
import { createPgPhoneRepository, hashCodeWith, newSixDigitCode, smsFromEnv } from "./phone-db";

interface Wired { db: Queryable; deps: ListingServiceDeps; enquiryDeps: EnquiryDeps; offerDeps: OfferDeps; phoneDeps: PhoneDeps; idDeps: IdDeps }
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
  const verification = (id: string) => getBuyerVerification(db, id);
  const offerDeps: OfferDeps = { offers: createPgOfferRepository(db), listings: repo, verification, appendAudit, now, newId };
  const appUrl = readAuthEnv()?.appUrl;
  const secret = readAuthEnv()?.secret;
  const phoneDeps: PhoneDeps = {
    phones: createPgPhoneRepository(db),
    // Without a session secret there is no safe way to hash codes, so verification stays blocked.
    sms: secret ? smsFromEnv() : undefined,
    hashCode: hashCodeWith(secret ?? ""),
    newCode: newSixDigitCode,
    appendAudit, now, newId
  };
  const idDeps: IdDeps = { ids: createPgIdRepository(db), files: fileStoreFromEnv(), staffFor: id => staffFor(db, id), appendAudit, now, newId };
  return {
    db,
    phoneDeps,
    idDeps,
    deps: { repo, appendAudit, now, newId, requiredDisclosures: getRequiredDisclosureKeys },
    offerDeps,
    enquiryDeps: {
      enquiries: createPgEnquiryRepository(db),
      listings: repo,
      verification,
      ...(appUrl ? { offerLinks: (listingId: string, buyerId: string) => issueOfferLink(offerDeps, appUrl, listingId, buyerId) } : {}),
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
export const getIdDeps = () => wired().idDeps;
export const getPhoneDeps = () => wired().phoneDeps;
export const getOfferDeps = () => wired().offerDeps;

export function getActor(req: Request): Actor | null {
  const auth = readAuthEnv();
  return auth ? actorFromRequest(req, auth.secret, Math.floor(Date.now() / 1000)) : null;
}
