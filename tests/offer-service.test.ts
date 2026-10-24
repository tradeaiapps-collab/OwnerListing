import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import type { BuyerVerification } from "../src/domain/buyer";
import {
  changeStatus, checkOfferLink, createInMemoryOfferRepository, issueOfferLink, myOffers, parseOfferInput, submitOffer,
  type OfferDeps, type OfferInput
} from "../src/domain/offer-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import type { PropertyListing } from "../src/domain/listing";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const buyer: Actor = { userId: "buyer-1", userType: "owner" };
const other: Actor = { userId: "other-1", userType: "owner" };
const full: BuyerVerification = { emailVerified: true, phoneVerified: true, idVerified: true };
const APP = "https://app.test";

let n = 0;
let clock: string;
let audit: AuditEvent[];
let verification: Record<string, BuyerVerification>;
let deps: OfferDeps;

const listing = (id: string, status: PropertyListing["status"]): PropertyListing => ({
  id, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status, title: `Home ${id}`,
  propertyType: "house", useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z"
});

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";
const input = (token: string, over: Partial<OfferInput> = {}): OfferInput => ({
  token, priceCents: 85_000_000, depositCents: 8_500_000, settlementDays: 45, conditions: ["Finance approval"], confirmedFinal: true, ...over
});

beforeEach(async () => {
  n = 0;
  clock = "2026-10-23T01:00:00.000Z";
  audit = [];
  verification = { [buyer.userId]: full };
  const listings = createInMemoryListingRepository();
  await listings.insert({ listing: listing("pub", "published"), listingFeePaid: true, termsAccepted: true });
  await listings.insert({ listing: listing("draft", "draft"), listingFeePaid: false, termsAccepted: false });
  deps = {
    offers: createInMemoryOfferRepository(), listings,
    verification: async id => verification[id] ?? { emailVerified: false, phoneVerified: false, idVerified: false },
    appendAudit: async e => { audit.push(e); }, now: () => clock, newId: () => `id-${++n}`
  };
});

describe("parseOfferInput", () => {
  it("accepts a full body and defaults conditions", () => {
    const r = parseOfferInput({ token: "t", priceCents: 1, depositCents: 0, settlementDays: 30, confirmedFinal: true });
    expect(r).toEqual({ ok: true, value: { token: "t", priceCents: 1, depositCents: 0, settlementDays: 30, conditions: [], confirmedFinal: true } });
  });
  it("rejects bad types and treats anything but true as not confirmed", () => {
    expect(parseOfferInput(null).ok).toBe(false);
    expect(parseOfferInput({ token: "", priceCents: 1, depositCents: 0, settlementDays: 30 }).ok).toBe(false);
    expect(parseOfferInput({ token: "t", priceCents: "1", depositCents: 0, settlementDays: 30 }).ok).toBe(false);
    expect(parseOfferInput({ token: "t", priceCents: 1, depositCents: 0, settlementDays: 30, conditions: [1] }).ok).toBe(false);
    const r = parseOfferInput({ token: "t", priceCents: 1, depositCents: 0, settlementDays: 30, confirmedFinal: "yes" });
    expect(r.ok && r.value.confirmedFinal).toBe(false);
  });
});

describe("offer links and submission", () => {
  it("issues a link, shows the property, and accepts one formal offer", async () => {
    const url = await issueOfferLink(deps, APP, "pub", buyer.userId);
    expect(url.startsWith(`${APP}/offers/new?token=`)).toBe(true);
    const chk = await checkOfferLink(deps, buyer, tokenOf(url));
    expect(chk.ok && chk.value.listingTitle).toBe("Home pub");
    const r = await submitOffer(deps, buyer, input(tokenOf(url)));
    expect(r.ok && r.value.status).toBe("submitted");
    expect(audit.map(e => e.eventType)).toEqual(["offer_link.created", "offer.submitted"]);
  });

  it("works only once", async () => {
    const t = tokenOf(await issueOfferLink(deps, APP, "pub", buyer.userId));
    expect((await submitOffer(deps, buyer, input(t))).ok).toBe(true);
    const again = await submitOffer(deps, buyer, input(t));
    expect(!again.ok && again.code).toBe("conflict");
  });

  it("rejects unknown links, another person's link and expired links", async () => {
    const t = tokenOf(await issueOfferLink(deps, APP, "pub", buyer.userId));
    const unknown = await submitOffer(deps, buyer, input("nope"));
    expect(!unknown.ok && unknown.code).toBe("not_found");
    verification[other.userId] = full;
    const stolen = await submitOffer(deps, other, input(t));
    expect(!stolen.ok && stolen.code).toBe("conflict");
    clock = "2026-10-25T01:00:00.000Z";
    const late = await submitOffer(deps, buyer, input(t));
    expect(!late.ok && late.message).toContain("expired");
  });

  it("needs full verification and a published listing, and blocks owners", async () => {
    const t = tokenOf(await issueOfferLink(deps, APP, "pub", buyer.userId));
    verification[buyer.userId] = { emailVerified: true, phoneVerified: true, idVerified: false };
    const unverified = await submitOffer(deps, buyer, input(t));
    expect(!unverified.ok && unverified.code).toBe("forbidden");
    verification[buyer.userId] = full;
    const dt = tokenOf(await issueOfferLink(deps, APP, "draft", buyer.userId));
    const draft = await submitOffer(deps, buyer, input(dt));
    expect(!draft.ok && draft.code).toBe("not_found");
    verification[owner.userId] = full;
    const ot = tokenOf(await issueOfferLink(deps, APP, "pub", owner.userId));
    const own = await submitOffer(deps, owner, input(ot));
    expect(!own.ok && own.code).toBe("forbidden");
  });

  it("enforces the offer rules without using up the link", async () => {
    const t = tokenOf(await issueOfferLink(deps, APP, "pub", buyer.userId));
    for (const bad of [
      input(t, { confirmedFinal: false }), input(t, { priceCents: 0 }), input(t, { settlementDays: 400 }),
      input(t, { depositCents: 90_000_000 }), input(t, { conditions: Array(11).fill("x") })
    ]) {
      const r = await submitOffer(deps, buyer, bad);
      expect(!r.ok && r.code).toBe("invalid");
    }
    expect((await submitOffer(deps, buyer, input(t))).ok).toBe(true);
  });
});

describe("decisions", () => {
  async function submitted() {
    const t = tokenOf(await issueOfferLink(deps, APP, "pub", buyer.userId));
    const r = await submitOffer(deps, buyer, input(t));
    return r.ok ? r.value.id : "";
  }

  it("lets the owner review then accept, with audit events, and never skip back", async () => {
    const id = await submitted();
    expect((await changeStatus(deps, owner, id, "under_review")).ok).toBe(true);
    const acc = await changeStatus(deps, owner, id, "accepted");
    expect(acc.ok && acc.value.status).toBe("accepted");
    expect(audit.map(e => e.eventType)).toContain("offer.accepted");
    const back = await changeStatus(deps, owner, id, "under_review");
    expect(!back.ok && back.code).toBe("conflict");
  });

  it("lets the buyer withdraw but not accept their own offer", async () => {
    const id = await submitted();
    const acc = await changeStatus(deps, buyer, id, "accepted");
    expect(!acc.ok && acc.code).toBe("conflict");
    expect((await changeStatus(deps, buyer, id, "withdrawn")).ok).toBe(true);
  });

  it("hides offers from everyone else", async () => {
    const id = await submitted();
    const r = await changeStatus(deps, other, id, "rejected");
    expect(!r.ok && r.code).toBe("not_found");
    expect(await myOffers(deps, other)).toEqual([]);
  });

  it("lists offers for both sides", async () => {
    await submitted();
    expect((await myOffers(deps, owner)).map(i => [i.role, i.listingTitle])).toEqual([["owner", "Home pub"]]);
    expect((await myOffers(deps, buyer)).map(i => [i.role, i.listingTitle])).toEqual([["buyer", "Home pub"]]);
  });
});
