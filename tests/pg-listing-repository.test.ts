import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inbox, getThread, reply, startEnquiry, type EnquiryDeps } from "../src/domain/enquiry-service";
import { createDraft, publishListing, searchPublished, updateDraft, type ListingServiceDeps } from "../src/domain/listing-service";
import { appendAuditPg, createPgListingRepository, type Queryable } from "../src/server/db";
import { changeStatus, checkOfferLink, issueOfferLink, myOffers, submitOffer, type OfferDeps } from "../src/domain/offer-service";
import { createPgOfferAlertRepository, createPgOfferRepository } from "../src/server/offer-db";
import { createPgEnquiryRepository, createPgNotificationRepository, getBuyerVerification } from "../src/server/enquiry-db";
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

  it("records email verification at login and gates enquiries until phone and ID are verified", async () => {
    const actor = { userId: ownerId, userType: "owner" as const };
    const l = await createDraft(deps, actor, { ...input, title: "Enquiry home" });
    const rec = await deps.repo.get(l.id);
    await deps.repo.save({ ...rec!, listingFeePaid: true, termsAccepted: true });
    await publishListing({ ...deps, trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }) }, actor, l.id, false);

    const sub = `buyer-${Date.now()}`;
    const buyerUser = await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: "Buyer" });
    const buyerActor = { userId: buyerUser!.id, userType: "owner" as const };
    expect(await getBuyerVerification(db, buyerActor.userId)).toEqual({ emailVerified: true, phoneVerified: false, idVerified: false });

    const edeps: EnquiryDeps = {
      enquiries: createPgEnquiryRepository(db), notifications: createPgNotificationRepository(db), listings: deps.repo,
      verification: id => getBuyerVerification(db, id),
      appendAudit: e => appendAuditPg(db, e), now: deps.now, newId: deps.newId
    };
    const blocked = await startEnquiry(edeps, buyerActor, l.id, "Hello");
    expect(!blocked.ok && blocked.code).toBe("forbidden");

    await db.query("UPDATE buyer_verification SET phone_verified_at = now(), id_verified_at = now() WHERE user_id = $1", [buyerActor.userId]);
    const started = await startEnquiry(edeps, buyerActor, l.id, "Hello");
    expect(started.ok).toBe(true);
    const id = started.ok ? started.value.enquiry.id : "";
    expect((await inbox(edeps, actor)).find(i => i.enquiry.id === id)?.unread).toBe(true);
    expect((await reply(edeps, actor, id, "Hi there")).ok).toBe(true);
    expect((await reply(edeps, actor, id, "Hi there")).ok).toBe(false);
    expect((await inbox(edeps, buyerActor)).find(i => i.enquiry.id === id)?.unread).toBe(true);
    const thread = await getThread(edeps, buyerActor, id);
    expect(thread.ok && thread.value.messages.map(m => m.body)).toEqual(["Hello", "Hi there"]);
    expect((await inbox(edeps, buyerActor)).find(i => i.enquiry.id === id)?.unread).toBe(false);
    expect((await getThread(edeps, { userId: crypto.randomUUID(), userType: "owner" }, id)).ok).toBe(false);

    await expect(db.query("UPDATE enquiry_message SET body = 'edited' WHERE enquiry_id = $1", [id])).rejects.toThrow();
    await expect(db.query("DELETE FROM enquiry_message WHERE enquiry_id = $1", [id])).rejects.toThrow();
  });

  it("keeps offers atomic and locked: one offer per link, terms frozen, no deletes, owner-only decisions", async () => {
    const actor = { userId: ownerId, userType: "owner" as const };
    const l = await createDraft(deps, actor, { ...input, title: "Offer home" });
    const rec = await deps.repo.get(l.id);
    await deps.repo.save({ ...rec!, listingFeePaid: true, termsAccepted: true });
    await publishListing({ ...deps, trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }) }, actor, l.id, false);

    const sub = `offerer-${Date.now()}`;
    const bu = await upsertGoogleUser(db, { sub, email: `${sub}@example.test`, name: "Offerer" });
    const buyerActor = { userId: bu!.id, userType: "owner" as const };
    await db.query("UPDATE buyer_verification SET phone_verified_at = now(), id_verified_at = now() WHERE user_id = $1", [buyerActor.userId]);

    const odeps: OfferDeps = {
      offers: createPgOfferRepository(db), alerts: createPgOfferAlertRepository(db), listings: deps.repo, verification: id => getBuyerVerification(db, id),
      appendAudit: e => appendAuditPg(db, e), now: deps.now, newId: deps.newId
    };
    const url = await issueOfferLink(odeps, "https://app.test", l.id, buyerActor.userId);
    const token = new URL(url).searchParams.get("token") ?? "";
    const chk = await checkOfferLink(odeps, buyerActor, token);
    expect(chk.ok && chk.value.listingTitle).toBe("Offer home");

    const body = { token, priceCents: 85_000_000, depositCents: 8_500_000, settlementDays: 45, conditions: ["Finance approval"], confirmedFinal: true };
    const [a, b] = await Promise.all([submitOffer(odeps, buyerActor, body), submitOffer(odeps, buyerActor, body)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const offer = a.ok ? a.value : b.ok ? b.value : undefined;
    expect(offer?.priceCents).toBe(85_000_000);

    await expect(db.query("UPDATE formal_offer SET price_cents = 1 WHERE id = $1", [offer!.id])).rejects.toThrow();
    await expect(db.query("DELETE FROM formal_offer WHERE id = $1", [offer!.id])).rejects.toThrow();

    expect((await changeStatus(odeps, { userId: crypto.randomUUID(), userType: "owner" }, offer!.id, "accepted")).ok).toBe(false);
    expect((await changeStatus(odeps, buyerActor, offer!.id, "accepted")).ok).toBe(false);
    expect((await myOffers(odeps, actor)).find(i => i.offer.id === offer!.id)?.unread).toBe(true);
    expect((await myOffers(odeps, actor)).find(i => i.offer.id === offer!.id)?.unread).toBe(false);
    const accepted = await changeStatus(odeps, actor, offer!.id, "accepted");
    expect((await myOffers(odeps, buyerActor)).find(i => i.offer.id === offer!.id)?.unread).toBe(true);
    expect(accepted.ok && accepted.value.status).toBe("accepted");
  });
});
