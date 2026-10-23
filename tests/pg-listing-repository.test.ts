import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDraft, publishListing, searchPublished, updateDraft, type ListingServiceDeps } from "../src/domain/listing-service";
import { appendAuditPg, createPgListingRepository, type Queryable } from "../src/server/db";
import { upsertGoogleUser } from "../src/server/users";

// Runs against a real PostgreSQL with all migrations applied (CI provides one). Without DATABASE_URL the suite is not collected.
const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("Postgres listing repository", () => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Queryable = {
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows as Record<string, unknown>[] };
    }
  };
  let deps: ListingServiceDeps;
  let ownerId = "";

  beforeAll(async () => {
    const sub = `sub-${Date.now()}`;
    const u = await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: "Test Owner" });
    ownerId = u!.id;
    deps = {
      repo: createPgListingRepository(db),
      appendAudit: e => appendAuditPg(db, e),
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
      requiredDisclosures: () => []
    };
  });
  afterAll(async () => { await pool.end(); });

  const input = { title: "PG home", address: "1 Test St NT", jurisdiction: "NT", transactionType: "sale", useClass: "residential", propertyType: "house" } as const;

  it("upserts the same Google user to the same id", async () => {
    const sub = `sub-same-${Date.now()}`;
    const a = await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: "A" });
    const b = await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: "A" });
    expect(a?.id).toBe(b?.id);
    expect(a?.userType).toBe("owner");
  });

  it("stores, edits and reads back a draft, trimming the padded state code", async () => {
    const actor = { userId: ownerId, userType: "owner" as const };
    const l = await createDraft(deps, actor, input);
    const got = await deps.repo.get(l.id);
    expect(got?.listing.jurisdiction).toBe("NT");
    expect(got?.listingFeePaid).toBe(false);
    const upd = await updateDraft(deps, actor, l.id, { title: "Renamed" });
    expect(upd.ok && upd.value.title).toBe("Renamed");
    expect((await deps.repo.get(l.id))?.listing.title).toBe("Renamed");
  });

  it("publishes only through the gate and lists it in search", async () => {
    const actor = { userId: ownerId, userType: "owner" as const };
    const l = await createDraft(deps, actor, { ...input, title: "Live home" });
    const blocked = await publishListing(deps, actor, l.id, false);
    expect(blocked.ok && blocked.value.decision.allowed).toBe(false);
    const rec = await deps.repo.get(l.id);
    await deps.repo.save({ ...rec!, listingFeePaid: true, termsAccepted: true });
    const ready = { ...deps, trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }) };
    const live = await publishListing(ready, actor, l.id, false);
    expect(live.ok && live.value.listing.status).toBe("published");
    const found = await searchPublished(deps, { jurisdiction: "NT" });
    expect(found.some(x => x.id === l.id)).toBe(true);
    const events = await db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1 ORDER BY occurred_at", [l.id]);
    expect(events.rows.map(r => r["event_type"])).toContain("listing.published");
  });

  it("does not let another user's id update a listing", async () => {
    const actor = { userId: ownerId, userType: "owner" as const };
    const l = await createDraft(deps, actor, input);
    const rec = await deps.repo.get(l.id);
    await deps.repo.save({ ...rec!, listing: { ...rec!.listing, ownerUserId: crypto.randomUUID(), title: "Hijacked" } });
    expect((await deps.repo.get(l.id))?.listing.title).toBe("PG home");
  });
});
