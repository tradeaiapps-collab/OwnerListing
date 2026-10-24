import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MESSAGES_PER_HOUR, MAX_NEW_ENQUIRIES_PER_DAY, MAX_UNANSWERED_BUYER_MESSAGES,
  createInMemoryEnquiryRepository, createInMemoryNotificationRepository, getThread, inbox, reply, startEnquiry,
  type EnquiryDeps
} from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import type { PropertyListing } from "../src/domain/listing";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const buyer: Actor = { userId: "buyer-1", userType: "owner" };
const full = { emailVerified: true, phoneVerified: true, idVerified: true };

let clock = 0;
let n = 0;
let deps: EnquiryDeps;

const listing = (id: string): PropertyListing => ({
  id, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: `Home ${id}`,
  propertyType: "house", useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z"
});

beforeEach(async () => {
  clock = Date.parse("2026-10-23T00:00:00Z");
  n = 0;
  const listings = createInMemoryListingRepository();
  for (let i = 0; i < 8; i++) await listings.insert({ listing: listing(`l${i}`), listingFeePaid: true, termsAccepted: true });
  deps = {
    enquiries: createInMemoryEnquiryRepository(), notifications: createInMemoryNotificationRepository(), listings,
    verification: async () => full, appendAudit: async () => {},
    now: () => new Date(clock).toISOString(), newId: () => `id-${++n}`
  };
});

describe("spam limits", () => {
  it("stops a buyer writing again and again without an owner reply, then allows it after a reply", async () => {
    const first = await startEnquiry(deps, buyer, "l0", "msg 0");
    const id = first.ok ? first.value.enquiry.id : "";
    for (let i = 1; i < MAX_UNANSWERED_BUYER_MESSAGES; i++) expect((await reply(deps, buyer, id, `msg ${i}`)).ok).toBe(true);
    expect(await reply(deps, buyer, id, "one more")).toMatchObject({ ok: false, code: "rate_limited" });
    expect((await reply(deps, owner, id, "Hi")).ok).toBe(true);
    expect((await reply(deps, buyer, id, "thanks")).ok).toBe(true);
  });

  it("limits new conversations per day", async () => {
    for (let i = 0; i < MAX_NEW_ENQUIRIES_PER_DAY; i++) expect((await startEnquiry(deps, buyer, `l${i}`, "Hello")).ok).toBe(true);
    expect(await startEnquiry(deps, buyer, "l5", "Hello")).toMatchObject({ ok: false, code: "rate_limited" });
    clock += 25 * 3_600_000;
    expect((await startEnquiry(deps, buyer, "l5", "Hello")).ok).toBe(true);
  });

  it("limits messages per hour for anyone, including owners", async () => {
    const s = await startEnquiry(deps, buyer, "l0", "Hello");
    const id = s.ok ? s.value.enquiry.id : "";
    for (let i = 1; i < MAX_MESSAGES_PER_HOUR; i++) expect((await reply(deps, owner, id, `answer ${i}`)).ok).toBe(true);
    expect((await reply(deps, owner, id, "x")).ok).toBe(true);
    // The owner has now sent MAX - 1 + 1 messages; the next is over the limit.
    expect(await reply(deps, owner, id, "too many")).toMatchObject({ ok: false, code: "rate_limited" });
    clock += 61 * 60_000;
    expect((await reply(deps, owner, id, "later")).ok).toBe(true);
  });

  it("rejects the same message sent twice in a row", async () => {
    const s = await startEnquiry(deps, buyer, "l0", "Hello");
    const id = s.ok ? s.value.enquiry.id : "";
    expect(await reply(deps, buyer, id, "Hello")).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("alerts", () => {
  it("alerts the owner once per conversation, clears when read, and alerts the buyer on a reply", async () => {
    const s = await startEnquiry(deps, buyer, "l0", "Hello");
    const id = s.ok ? s.value.enquiry.id : "";
    await reply(deps, buyer, id, "Also, parking?");
    expect((await inbox(deps, owner)).map(i => i.unread)).toEqual([true]);
    expect((await inbox(deps, buyer)).map(i => i.unread)).toEqual([false]);
    await getThread(deps, owner, id);
    expect((await inbox(deps, owner)).map(i => i.unread)).toEqual([false]);
    await reply(deps, owner, id, "Yes");
    expect((await inbox(deps, buyer)).map(i => i.unread)).toEqual([true]);
  });

  it("does not lose a message when the alert store fails", async () => {
    deps.notifications = { notifyMessage: async () => { throw new Error("down"); }, markRead: async () => {}, unreadEnquiryIds: async () => [] };
    expect((await startEnquiry(deps, buyer, "l0", "Hello")).ok).toBe(true);
  });
});
