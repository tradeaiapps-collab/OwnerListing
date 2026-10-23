import { randomUUID } from "node:crypto";
import { getRequiredDisclosureKeys } from "../config/disclosures";
import type { AuditEvent } from "../domain/audit";
import {
  createInMemoryListingRepository,
  type Actor,
  type ListingServiceDeps
} from "../domain/listing-service";

/**
 * Temporary in-memory wiring until the PostgreSQL repository and Google login land in their own packages.
 * Data is lost on restart. Never used in production (see getActor).
 */
interface Store { deps: ListingServiceDeps; audit: AuditEvent[] }
const g = globalThis as unknown as { __ownerlisting?: Store };

export function getDeps(): ListingServiceDeps {
  const existing = g.__ownerlisting;
  if (existing) return existing.deps;
  const audit: AuditEvent[] = [];
  const deps: ListingServiceDeps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async e => { audit.push(e); },
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    requiredDisclosures: getRequiredDisclosureKeys
  };
  g.__ownerlisting = { deps, audit };
  return deps;
}

/**
 * Development-only identity from headers x-dev-user-id and x-dev-user-type (owner or agent).
 * In production there is no identity until Google login exists, so every caller is anonymous.
 */
export function getActor(req: Request, env: string | undefined = process.env["NODE_ENV"]): Actor | null {
  if (env === "production") return null;
  const userId = req.headers.get("x-dev-user-id")?.trim();
  const userType = req.headers.get("x-dev-user-type");
  if (!userId || userId.length > 100) return null;
  if (userType !== "owner" && userType !== "agent") return null;
  return { userId, userType };
}
