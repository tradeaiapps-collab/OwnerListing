import { beforeEach, describe, expect, it } from "vitest";
import { blockMessage, scanContent } from "../src/domain/content-filter";
import type { AuditEvent } from "../src/domain/audit";
import type { BuyerVerification } from "../src/domain/buyer";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import {
  createInMemoryEnquiryRepository, discardDraft, getAutoReply, getThread, inbox, listDrafts, parseMessageBody, reply,
  sendDraft, startEnquiry, updateAutoReply, type EnquiryDeps
} from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import type { PropertyListing } from "../src/domain/listing";
import { ENQUIRY_RATE } from "../src/domain/rate-limit";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const buyer: Actor = { userId: "buyer-1", userType: "buyer" };
const other: Actor = { userId: "buyer-2", userType: "buyer" };
const stranger: Actor = { userId: "owner-2", userType: "owner" };
const full: BuyerVerification = { emailVerified: true, phoneVerified: true, idVerified: true };

let n = 0;
let clock = 0;
let hits: Map<string, number>;
let audit: AuditEvent[];
let verification: Record<string, BuyerVerification>;
let repo: ReturnType<typeof createInMemoryEnquiryRepository>;
let deps: EnquiryDeps;

const listing = (id: string, status: PropertyListing["status"] = "published", ownerUserId = owner.userId): PropertyListing => ({
  id, ownerUserId, ownerUserType: "owner", jurisdiction: "QLD", status, title: `Home ${id}`, propertyType: "house",
  useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z"
});

beforeEach(async () => {
  n = 0;
  clock = Date.parse("2026-10-24T00:00:00Z");
  hits = new Map();
  audit = [];
  verification = { [buyer.userId]: full, [other.userId]: full };
  const listings = createInMemoryListingRepository();
  for (let i = 0; i < 8; i++) await listings.insert({ listing: listing(`l${i}`), listingFeePaid: true, termsAccepted: true });
  await listings.insert({ listing: listing("draft", "draft"), listingFeePaid: true, termsAccepted: true });
  repo = createInMemoryEnquiryRepository();
  deps = {
    enquiries: repo, listings,
    drafts: createInMemoryDraftRepository(() => owner.userId),
    verification: async id => verification[id] ?? { emailVerified: false, phoneVerified: false, idVerified: false },
    countHit: async (key, windowMs) => {
      const k = `${key}|${Math.floor(clock / windowMs)}`;
      hits.set(k, (hits.get(k) ?? 0) + 1);
      return hits.get(k);
    },
    termsCurrentFor: async () => true,
    offerRequestUrl: id => `http://test/enquiries/${id}`,
    appendAudit: async e => { audit.push(e); },
    now: () => new Date(clock).toISOString(), newId: () => `id-${++n}`
  };
});

const start = async (a: Actor = buyer, listingId = "l0", body = "Is it still available?") => {
  const r = await startEnquiry(deps, a, listingId, body);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

describe("starting an enquiry", () => {
  it("lets a fully verified buyer message the owner and audits it", async () => {
    const { enquiry, message } = await start();
    expect(message).toMatchObject({ senderUserId: buyer.userId, automated: false });
    expect(audit.some(e => e.eventType === "enquiry.message_sent" && e.aggregateId === enquiry.id)).toBe(true);
  });
  it("reuses the buyer's thread for the same listing", async () => {
    const a = await start();
    const b = await start(buyer, "l0", "Second question");
    expect(b.enquiry.id).toBe(a.enquiry.id);
  });
  it("denies an unverified buyer, naming the next step, and creates nothing", async () => {
    for (const [v, text] of [
      [{ ...full, emailVerified: false }, "email"], [{ ...full, phoneVerified: false }, "mobile"], [{ ...full, idVerified: false }, "ID check"]
    ] as const) {
      verification[buyer.userId] = v;
      const r = await startEnquiry(deps, buyer, "l0", "Hi");
      expect(r).toMatchObject({ ok: false, code: "forbidden" });
      expect(r.ok ? "" : r.message).toContain(text);
    }
    verification = {};
    expect(await startEnquiry(deps, buyer, "l0", "Hi")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await inbox(deps, buyer)).toEqual([]);
  });
  it("denies non-buyer accounts, own listings, drafts and unknown listings", async () => {
    expect(await startEnquiry(deps, stranger, "l0", "Hi")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await startEnquiry(deps, { ...owner, userType: "buyer" }, "l0", "Hi")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await startEnquiry(deps, buyer, "draft", "Hi")).toMatchObject({ ok: false, code: "not_found" });
    expect(await startEnquiry(deps, buyer, "nope", "Hi")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("rejects empty and over-long messages", () => {
    expect(parseMessageBody({ body: "  " }).ok).toBe(false);
    expect(parseMessageBody({ body: "x".repeat(4001) }).ok).toBe(false);
    expect(parseMessageBody(null).ok).toBe(false);
  });
});

describe("thread access", () => {
  it("shows the thread only to its buyer and the listing owner (same not_found for others)", async () => {
    const { enquiry } = await start();
    expect((await getThread(deps, buyer, enquiry.id)).ok).toBe(true);
    expect((await getThread(deps, owner, enquiry.id)).ok).toBe(true);
    for (const who of [other, stranger]) {
      expect(await getThread(deps, who, enquiry.id)).toMatchObject({ ok: false, code: "not_found" });
      expect(await reply(deps, who, enquiry.id, "hello")).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await getThread(deps, buyer, "missing")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("stops a buyer who loses verification from posting in an existing thread", async () => {
    const { enquiry } = await start();
    verification[buyer.userId] = { ...full, idVerified: false };
    expect(await reply(deps, buyer, enquiry.id, "more")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await reply(deps, owner, enquiry.id, "ok")).ok).toBe(true);
  });
  it("has no edit or delete function and no repository method to change a message", async () => {
    const svc = await import("../src/domain/enquiry-service");
    expect(Object.keys(svc).filter(k => /edit|update|delete|remove/i.test(k))).toEqual(["updateAutoReply"]);
    expect(Object.keys(repo).filter(k => /edit|update|delete|remove/i.test(k))).toEqual([]);
  });
});

describe("inbox and unread counts", () => {
  it("counts the other side's unread messages and clears them when the thread is read", async () => {
    const { enquiry } = await start();
    await reply(deps, buyer, enquiry.id, "Also, parking?");
    expect((await inbox(deps, owner))[0]).toMatchObject({ role: "owner", unread: 2 });
    expect((await inbox(deps, buyer))[0]).toMatchObject({ role: "buyer", unread: 0 });
    clock += 1000;
    await getThread(deps, owner, enquiry.id);
    expect((await inbox(deps, owner))[0]?.unread).toBe(0);
    clock += 1000;
    await reply(deps, owner, enquiry.id, "Yes, one space.");
    expect((await inbox(deps, buyer))[0]?.unread).toBe(1);
  });
  it("does not show other people's threads", async () => {
    await start();
    expect(await inbox(deps, other)).toEqual([]);
    expect(await inbox(deps, stranger)).toEqual([]);
  });
});

describe("spam limits per buyer", () => {
  it("limits new threads per day, then allows after the window", async () => {
    for (let i = 0; i < ENQUIRY_RATE.newThreads.perBuyer; i++) await start(buyer, `l${i}`);
    expect(await startEnquiry(deps, buyer, "l5", "Hi")).toMatchObject({ ok: false, code: "rate_limited" });
    clock += 25 * 3_600_000;
    expect((await startEnquiry(deps, buyer, "l5", "Hi")).ok).toBe(true);
  });
  it("limits messages per hour, and one buyer's limit does not affect another", async () => {
    const { enquiry } = await start();
    for (let i = 1; i < ENQUIRY_RATE.messages.perBuyer; i++) expect((await reply(deps, buyer, enquiry.id, `m${i}`)).ok).toBe(true);
    expect(await reply(deps, buyer, enquiry.id, "too many")).toMatchObject({ ok: false, code: "rate_limited" });
    expect((await start(other)).message.body).toBeTruthy();
    expect((await reply(deps, owner, enquiry.id, "owner can still answer")).ok).toBe(true);
  });
  it("fails closed when the counter is unavailable", async () => {
    deps.countHit = async () => undefined;
    expect(await startEnquiry(deps, buyer, "l0", "Hi")).toMatchObject({ ok: false, code: "rate_limited" });
    deps.countHit = async () => { throw new Error("db down"); };
    expect(await startEnquiry(deps, buyer, "l0", "Hi")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(repo.messagesAll).toEqual([]);
  });
});

describe("chat offer notice", () => {
  const offerText = "I can pay $850,000 for it";
  it("adds one automated notice with the offer-flow link, and not again within the hour", async () => {
    const { enquiry } = await start(buyer, "l0", offerText);
    await reply(deps, buyer, enquiry.id, "I'll offer $860,000 then");
    const auto = repo.messagesAll.filter(m => m.automated);
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ senderUserId: null });
    expect(auto[0]?.body).toContain(`http://test/enquiries/${enquiry.id}`);
    expect(auto[0]?.body).toContain("not formal offers");
    clock += 61 * 60_000;
    await reply(deps, buyer, enquiry.id, "I will pay $870,000");
    expect(repo.messagesAll.filter(m => m.automated)).toHaveLength(2);
  });
  it("does not react to ordinary messages or to owner messages, and never issues a link", async () => {
    const { enquiry } = await start();
    await reply(deps, owner, enquiry.id, "I will accept offers around $900,000");
    expect(repo.messagesAll.some(m => m.automated)).toBe(false);
    expect(repo.messagesAll.every(m => !/token|[?&]t=/.test(m.body))).toBe(true);
  });
});

describe("auto-reply preview drafts", () => {
  const turnOn = async () => {
    await updateAutoReply(deps, owner, { enabled: true, templateBody: "Thanks for your enquiry. Inspections are on Saturdays." });
  };
  it("queues a draft from an owner-approved template and sends nothing", async () => {
    await turnOn();
    const { enquiry } = await start();
    const drafts = await listDrafts(deps, owner);
    expect(drafts.ok && drafts.value).toHaveLength(1);
    const d = drafts.ok ? drafts.value[0] : undefined;
    expect(d).toMatchObject({ enquiryId: enquiry.id, status: "queued", reviewUntil: "2026-10-24T00:30:00.000Z" });
    expect(repo.messagesAll.filter(m => m.senderUserId === owner.userId)).toEqual([]);
  });
  it("queues nothing when off, paused, without a template, or for an offer-looking message", async () => {
    await start(buyer, "l0");
    await updateAutoReply(deps, owner, { enabled: true });
    await start(buyer, "l1");
    await turnOn();
    await updateAutoReply(deps, owner, { paused: true });
    await start(buyer, "l2");
    await updateAutoReply(deps, owner, { paused: false });
    await start(buyer, "l3", "I can pay $850,000");
    const drafts = await listDrafts(deps, owner);
    expect(drafts.ok && drafts.value).toEqual([]);
  });
  it("only the owner can see, send or discard drafts", async () => {
    await turnOn();
    await start();
    const id = ((await listDrafts(deps, owner)) as { value: { id: string }[] }).value[0]!.id;
    expect(await listDrafts(deps, stranger)).toEqual({ ok: true, value: [] });
    for (const who of [buyer, stranger]) {
      expect(await discardDraft(deps, who, id)).toMatchObject({ ok: false });
      expect(await sendDraft(deps, who, id)).toMatchObject({ ok: false });
    }
    expect(await listDrafts(deps, buyer)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getAutoReply(deps, buyer)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateAutoReply(deps, buyer, { paused: false })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await listDrafts(deps, owner)) as { value: unknown[] }).toMatchObject({ value: [{ id }] });
  });
  it("sends a draft only when the owner chooses, as the owner's own message, once", async () => {
    await turnOn();
    const { enquiry } = await start();
    const id = ((await listDrafts(deps, owner)) as { value: { id: string }[] }).value[0]!.id;
    expect((await sendDraft(deps, owner, id)).ok).toBe(true);
    expect(repo.messagesAll.at(-1)).toMatchObject({ enquiryId: enquiry.id, senderUserId: owner.userId, body: "Thanks for your enquiry. Inspections are on Saturdays." });
    expect(await sendDraft(deps, owner, id)).toMatchObject({ ok: false });
    expect(await discardDraft(deps, owner, id)).toMatchObject({ ok: false });
  });
  it("validates the switches", async () => {
    expect(await updateAutoReply(deps, owner, { paused: "yes" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await updateAutoReply(deps, owner, { reviewWindowMinutes: 0 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await updateAutoReply(deps, owner, { templateBody: " " })).toMatchObject({ ok: false, code: "invalid" });
    expect(await updateAutoReply(deps, owner, null)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("anti-discrimination wording on owner messages", () => {
  it("refuses an owner reply with discriminatory wording, stores nothing, and allows a neutral one", async () => {
    const { enquiry } = await start();
    const before = (await deps.enquiries.messages(enquiry.id)).length;
    const r = await reply(deps, owner, enquiry.id, "Sorry, no kids in this unit.");
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(!r.ok && r.message).toMatch(/can't be sent because "[^"]*no kids" may be discriminatory/);
    expect((await deps.enquiries.messages(enquiry.id)).length).toBe(before);
    expect((await reply(deps, owner, enquiry.id, "The unit has two bedrooms and a lift.")).ok).toBe(true);
  });

  it("does not filter the buyer's own words (escalation is the AI handoff's job)", async () => {
    const { enquiry } = await start();
    expect((await reply(deps, buyer, enquiry.id, "Is it true there are no kids allowed?")).ok).toBe(true);
  });

  it("refuses an auto-reply template with discriminatory wording", async () => {
    const r = await updateAutoReply(deps, owner, { templateBody: "Thanks! Note: professionals only." });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(!r.ok && r.message).toMatch(/template can't be saved/);
    expect((await updateAutoReply(deps, owner, { templateBody: "Thanks, inspections are on Saturday at 10." })).ok).toBe(true);
  });
});

describe("content filter on messages", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    deps.contentGuard = async ({ text }) => {
      const s = scanContent(text);
      if (s.action === "block") return { ok: false, message: blockMessage(s, "message") };
      return { ok: true, after: async id => { if (s.action === "flag") calls.push(id); } };
    };
  });
  it("refuses a first message with contact details and stores nothing", async () => {
    const r = await startEnquiry(deps, buyer, "l0", "Call me on 0412 345 678");
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(await repo.listByBuyer(buyer.userId).then(x => x.length ? repo.messages(x[0]!.id) : [])).toEqual([]);
  });
  it("leaves no empty thread behind when the first message is refused, and creates it when a later try passes", async () => {
    expect(await startEnquiry(deps, buyer, "l0", "Call me on 0412 345 678")).toMatchObject({ ok: false });
    expect(await repo.listByBuyer(buyer.userId)).toEqual([]);
    const ok = await startEnquiry(deps, buyer, "l0", "Is the street quiet?");
    expect(ok.ok).toBe(true);
    expect(await repo.listByBuyer(buyer.userId)).toHaveLength(1);
  });
  it("refuses an abusive reply from the owner", async () => {
    const { enquiry } = await start();
    expect(await reply(deps, owner, enquiry.id, "you idiot")).toMatchObject({ ok: false, code: "invalid" });
  });
  it("stores a flagged message and reports its id", async () => {
    const { enquiry } = await start();
    const r = await reply(deps, owner, enquiry.id, "Honestly that is crap");
    expect(r.ok).toBe(true);
    if (r.ok) expect(calls).toEqual([r.value.id]);
  });
  it("passes a clean message and a failing flag store cannot lose it", async () => {
    deps.contentGuard = async () => ({ ok: true, after: async () => { throw new Error("db down"); } });
    const { enquiry } = await start();
    expect((await reply(deps, owner, enquiry.id, "Saturday at 10 works")).ok).toBe(true);
  });
});
