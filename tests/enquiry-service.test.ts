import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import type { BuyerVerification } from "../src/domain/buyer";
import {
  createInMemoryEnquiryRepository, getThread, inbox, parseMessageBody, reply, startEnquiry,
  type EnquiryDeps
} from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import type { PropertyListing } from "../src/domain/listing";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const buyer: Actor = { userId: "buyer-1", userType: "owner" };
const stranger: Actor = { userId: "stranger-1", userType: "owner" };
const full: BuyerVerification = { emailVerified: true, phoneVerified: true, idVerified: true };

let n = 0;
let audit: AuditEvent[];
let verification: Record<string, BuyerVerification>;
let deps: EnquiryDeps;

const listing = (id: string, status: PropertyListing["status"], ownerUserId = owner.userId): PropertyListing => ({
  id, ownerUserId, ownerUserType: "owner", jurisdiction: "QLD", status, title: `Home ${id}`, propertyType: "house",
  useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z"
});

beforeEach(async () => {
  n = 0;
  audit = [];
  verification = { [buyer.userId]: full };
  const listings = createInMemoryListingRepository();
  await listings.insert({ listing: listing("pub", "published"), listingFeePaid: true, termsAccepted: true });
  await listings.insert({ listing: listing("draft", "draft"), listingFeePaid: false, termsAccepted: false });
  deps = {
    enquiries: createInMemoryEnquiryRepository(),
    listings,
    verification: async id => verification[id] ?? { emailVerified: false, phoneVerified: false, idVerified: false },
    appendAudit: async e => { audit.push(e); },
    now: () => `2026-10-23T00:00:${String(n).padStart(2, "0")}.000Z`,
    newId: () => `id-${++n}`
  };
});

describe("parseMessageBody", () => {
  it("trims and accepts, rejects empty, missing and over-long", () => {
    expect(parseMessageBody({ body: "  hi  " })).toEqual({ ok: true, value: "hi" });
    expect(parseMessageBody({ body: "   " }).ok).toBe(false);
    expect(parseMessageBody({}).ok).toBe(false);
    expect(parseMessageBody(null).ok).toBe(false);
    expect(parseMessageBody({ body: "x".repeat(4001) }).ok).toBe(false);
    expect(parseMessageBody({ body: "x".repeat(4000) }).ok).toBe(true);
  });
});

describe("startEnquiry", () => {
  it("lets a fully verified buyer message the owner and audits it", async () => {
    const r = await startEnquiry(deps, buyer, "pub", "Is it still available?");
    expect(r.ok && r.value.message.body).toBe("Is it still available?");
    expect(audit.map(e => e.eventType)).toEqual(["enquiry.message_sent"]);
  });

  it("re-uses the same thread for the same buyer and listing", async () => {
    const a = await startEnquiry(deps, buyer, "pub", "First");
    const b = await startEnquiry(deps, buyer, "pub", "Second");
    expect(a.ok && b.ok && a.value.enquiry.id === b.value.enquiry.id).toBe(true);
    const t = await getThread(deps, buyer, a.ok ? a.value.enquiry.id : "");
    expect(t.ok && t.value.messages.map(m => m.body)).toEqual(["First", "Second"]);
  });

  it("blocks each unverified step and says which one is next", async () => {
    const cases: [BuyerVerification, string][] = [
      [{ emailVerified: false, phoneVerified: false, idVerified: false }, "email"],
      [{ emailVerified: true, phoneVerified: false, idVerified: false }, "mobile"],
      [{ emailVerified: true, phoneVerified: true, idVerified: false }, "ID check"]
    ];
    for (const [v, word] of cases) {
      verification[buyer.userId] = v;
      const r = await startEnquiry(deps, buyer, "pub", "Hello");
      expect(!r.ok && r.code).toBe("forbidden");
      expect(!r.ok && r.message).toContain(word);
    }
    expect(audit).toEqual([]);
  });

  it("treats a buyer with no verification record as unverified", async () => {
    const r = await startEnquiry(deps, stranger, "pub", "Hello");
    expect(!r.ok && r.code).toBe("forbidden");
  });

  it("only works on published listings", async () => {
    const draft = await startEnquiry(deps, buyer, "draft", "Hello");
    expect(!draft.ok && draft.code).toBe("not_found");
    const missing = await startEnquiry(deps, buyer, "nope", "Hello");
    expect(!missing.ok && missing.code).toBe("not_found");
  });

  it("does not let an owner enquire on their own listing", async () => {
    verification[owner.userId] = full;
    const r = await startEnquiry(deps, owner, "pub", "Hello");
    expect(!r.ok && r.code).toBe("forbidden");
  });
});

describe("offer prompt", () => {
  const withLinks = (): EnquiryDeps => ({ ...deps, offerLinks: async (l, b) => `https://app.test/offers/new?token=${l}-${b}` });

  it("sends one system reply with a link when the buyer's message reads like an offer", async () => {
    const d = withLinks();
    const r = await startEnquiry(d, buyer, "pub", "I can offer $850,000 for it");
    const id = r.ok ? r.value.enquiry.id : "";
    const t = await getThread(d, buyer, id);
    const msgs = t.ok ? t.value.messages : [];
    expect(msgs.map(m => m.automated)).toEqual([false, true]);
    expect(msgs[1]?.senderUserId).toBeNull();
    expect(msgs[1]?.body).toContain("https://app.test/offers/new?token=pub-buyer-1");
    expect(audit.map(e => e.eventType)).toContain("enquiry.offer_prompt_sent");
  });

  it("does not repeat inside the cooldown, and ignores ordinary questions and owner messages", async () => {
    const d = withLinks();
    const a = await startEnquiry(d, buyer, "pub", "Would you take $800k?");
    const id = a.ok ? a.value.enquiry.id : "";
    await reply(d, buyer, id, "I'll pay $820,000");
    await reply(d, buyer, id, "Is parking included?");
    await reply(d, owner, id, "I can do $900,000");
    const t = await getThread(d, buyer, id);
    expect((t.ok ? t.value.messages : []).filter(m => m.automated)).toHaveLength(1);
  });

  it("sends nothing when offer links are not configured", async () => {
    const r = await startEnquiry(deps, buyer, "pub", "I can offer $850,000");
    const t = await getThread(deps, buyer, r.ok ? r.value.enquiry.id : "");
    expect((t.ok ? t.value.messages : []).some(m => m.automated)).toBe(false);
  });
});

describe("threads", () => {
  it("lets the owner and buyer read and reply, and hides it from everyone else", async () => {
    const s = await startEnquiry(deps, buyer, "pub", "Hello");
    const id = s.ok ? s.value.enquiry.id : "";
    const rep = await reply(deps, owner, id, "Yes it is");
    expect(rep.ok && rep.value.senderUserId).toBe(owner.userId);
    const t = await getThread(deps, buyer, id);
    expect(t.ok && t.value.messages.map(m => m.body)).toEqual(["Hello", "Yes it is"]);

    expect((await getThread(deps, stranger, id)).ok).toBe(false);
    const sneaky = await reply(deps, stranger, id, "Hi");
    expect(!sneaky.ok && sneaky.code).toBe("not_found");
    expect((await getThread(deps, buyer, "missing")).ok).toBe(false);
  });
});

describe("inbox", () => {
  it("shows owners their listing's threads and buyers the ones they started, newest first", async () => {
    const a = await startEnquiry(deps, buyer, "pub", "Hello");
    expect(a.ok).toBe(true);
    const o = await inbox(deps, owner);
    expect(o.map(i => [i.role, i.listingTitle])).toEqual([["owner", "Home pub"]]);
    const b = await inbox(deps, buyer);
    expect(b.map(i => [i.role, i.listingTitle])).toEqual([["buyer", "Home pub"]]);
    expect(await inbox(deps, stranger)).toEqual([]);
  });
});
