import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  askAssistant, chatAnswer, showMeFor, chatWelcome, createInMemoryTurnRepository, getAssistantThread, matchChatTopic, middleCents, parseQuestion, positions,
  type ChatAssistantDeps, type ChatFacts, type ChatOffer
} from "../src/domain/chat-assistant";
import { createInMemoryEnquiryRepository } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as ChatAssistantDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor }));
vi.mock("../src/server/chat-assistant-db", () => ({ getChatAssistantDeps: () => state.deps }));

import * as route from "../app/api/enquiries/[id]/assistant/route";

const L = "11111111-1111-4111-8111-111111111111";
const E = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "buyer" };

const offer: ChatOffer = {
  priceCents: 108_000_000, depositCents: 10_800_000, settlementDays: 30,
  conditions: ["Subject to finance", "Subject to building and pest inspection"], status: "submitted"
};
const facts = (o: ChatOffer | null = offer): ChatFacts => ({
  listing: { title: "Banksia home", address: "14 Banksia St, Paddington QLD", transactionType: "sale", propertyType: "house", askingCents: 115_000_000, bedrooms: 4, bathrooms: 2, parking: 2, verifiedDisclosures: 2 },
  offer: o ?? undefined
});

describe("topics", () => {
  it.each([
    ["How could we close the gap?", "compromise"],
    ["Can we meet in the middle?", "compromise"],
    ["Where do things stand with the offer?", "offer"],
    ["What does settlement mean?", "settlement"],
    ["Where does the deposit go?", "deposit"],
    ["What does subject to finance mean?", "conditions"],
    ["How many bedrooms does it have?", "listing"],
    ["What happens next?", "next_steps"],
    ["What's the lowest price the owner will accept?", "privacy"],
    ["What is the buyer's phone number?", "privacy"],
    ["Should I accept this offer?", "advice"],
    ["Is this a good price?", "advice"],
    ["Tell me a joke", "unknown"]
  ])("%s -> %s", (q, topic) => expect(matchChatTopic(q)).toBe(topic));
});

describe("answers use only shared facts", () => {
  it("summarises the offer, asking price and whose turn it is", () => {
    const a = chatAnswer(facts(), "owner", "Where do things stand?");
    expect(a.pose).toBe("tablet");
    expect(a.text).toContain("$1,080,000");
    expect(a.text).toContain("$1,150,000");
    expect(a.text).toContain("30 days");
    expect(a.text).toContain("with the owner");
  });

  it("suggests a rounded middle and non-price levers, and says it is not binding", () => {
    const a = chatAnswer(facts(), "buyer", "How could we close the gap?");
    expect(a.text).toContain("$70,000 apart");
    expect(a.text).toContain("around $1,115,000");
    expect(a.text).toContain("settlement time");
    expect(a.text).toContain("Only the two of you can agree terms");
  });

  it("uses the owner's counter, not the asking price, once there is one", () => {
    const o: ChatOffer = { ...offer, status: "countered", counter: { ...offer, priceCents: 112_000_000, fromParty: "owner", status: "open" } };
    expect(positions(facts(o))).toEqual({ buyerCents: 108_000_000, ownerCents: 112_000_000, ownerSource: "counter" });
    const a = chatAnswer(facts(o), "buyer", "Can we meet halfway?");
    expect(a.text).toContain("$40,000 apart");
    expect(a.text).toContain("around $1,100,000");
  });

  it("a buyer's counter back moves the buyer's side", () => {
    const o: ChatOffer = { ...offer, status: "buyer_countered", counter: { ...offer, priceCents: 109_500_000, fromParty: "buyer", status: "open" } };
    expect(positions(facts(o))?.buyerCents).toBe(109_500_000);
  });

  it("the middle is round and stays between the two sides", () => {
    expect(middleCents(108_000_000, 112_000_000, "sale")).toBe(110_000_000);
    expect(middleCents(108_000_000, 108_400_000, "sale")).toBe(108_200_000);
    expect(middleCents(60_000, 65_000, "rent")).toBe(62_500);
  });

  it("never reveals a floor and refuses personal details", () => {
    expect(chatAnswer(facts(), "buyer", "What's the lowest the owner will take?").text).toMatch(/don't know the owner's lowest price/);
    const p = chatAnswer(facts(), "owner", "What is the buyer's email?");
    expect(p.pose).toBe("three-quarter");
    expect(p.text).toMatch(/don't share personal details/);
  });

  it("declines advice and points to a professional", () => {
    expect(chatAnswer(facts(), "owner", "Should I accept?").text).toContain("solicitor or conveyancer");
  });

  it("explains the offer's conditions and the deposit's trust account", () => {
    expect(chatAnswer(facts(), "buyer", "What do the conditions mean?").text).toContain("Subject to building and pest");
    const d = chatAnswer(facts(), "buyer", "Where does the deposit go?").text;
    expect(d).toContain("solicitor's trust account");
    expect(d).toContain("$108,000 deposit (10%");
  });

  it("works without an offer", () => {
    expect(chatAnswer(facts(null), "buyer", "How could we close the gap?").text).toContain("no formal offer");
    expect(chatWelcome(facts(null), "Elena").text).toContain("Hi, I'm Elena");
  });

  it("welcome says both parties see her answers and she is not an agent", () => {
    const w = chatWelcome(facts(), "Elena");
    expect(w.pose).toBe("wave");
    expect(w.text).toContain("seen by both of you");
    expect(w.text).toContain("not a licensed agent");
  });
});

describe("show me", () => {
  it("sends a buyer to My offers and an owner to their listings, with the offer link as the fallback", () => {
    expect(showMeFor("compromise", "buyer", facts())).toEqual({ label: "Show me where to reply to the offer", places: ["my_offers", "offer_link"] });
    expect(showMeFor("offer", "owner", facts())?.places).toEqual(["my_listings", "offer_link"]);
    expect(showMeFor("next_steps", "agent", facts())?.places[0]).toBe("my_listings");
  });
  it("without an offer only the buyer is pointed at the offer-link request", () => {
    expect(showMeFor("next_steps", "buyer", facts(null))?.places).toEqual(["offer_link"]);
    expect(showMeFor("next_steps", "owner", facts(null))).toBeUndefined();
  });
  it("answers about settlement, deposit, privacy and advice never walk anywhere", () => {
    for (const t of ["settlement", "deposit", "conditions", "listing", "privacy", "advice", "unknown", "welcome"] as const) expect(showMeFor(t, "buyer", facts())).toBeUndefined();
  });
});

describe("parseQuestion", () => {
  it("needs text up to 500 characters", () => {
    expect(parseQuestion({ question: "  " }).ok).toBe(false);
    expect(parseQuestion({ question: "x".repeat(501) }).ok).toBe(false);
    expect(parseQuestion({ question: " Hi " })).toEqual({ ok: true, value: "Hi" });
  });
});

let n = 0;
let hits = 1;
let termsOk = true;
const turns = () => (state.deps!.turns as ReturnType<typeof createInMemoryTurnRepository>).all;
beforeEach(async () => {
  n = 0; hits = 1; termsOk = true; state.actor = null;
  const listings = createInMemoryListingRepository();
  await listings.insert({
    listing: {
      id: L, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Banksia home", propertyType: "house",
      useClass: "residential", transactionType: "sale", address: "14 Banksia St", disclosures: [], priceCents: 115_000_000,
      createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z"
    },
    listingFeePaid: true, termsAccepted: true
  });
  const enquiries = createInMemoryEnquiryRepository();
  await enquiries.insert({ id: E, listingId: L, buyerUserId: buyer.userId, createdAt: "2026-10-30T00:00:00.000Z" });
  state.deps = {
    enquiries, listings, termsCurrentFor: async () => termsOk, countHit: async () => hits, now: () => "2026-10-30T01:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, appendAudit: vi.fn(async () => {}),
    turns: createInMemoryTurnRepository(), offerFor: async () => offer, verifiedDisclosures: async () => 1, persona: async () => ({ id: "elena" as const, name: "Elena", icon: "/i.png", portrait: "/p.jpg", poses: {} })
  };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ask = (question: unknown, headers: Record<string, string> = {}) =>
  route.POST(new Request(`http://test/api/enquiries/${E}/assistant`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://test", ...headers }, body: JSON.stringify({ question })
  }), ctx(E));
process.env["APP_URL"] = "http://test";

describe("service and route", () => {
  it("exports only GET and POST: the record is never edited or deleted", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "POST"]);
  });

  it("a party asks; both parties then see the same question and answer", async () => {
    state.actor = buyer;
    const r = await ask("How could we close the gap?");
    expect(r.status).toBe(201);
    const { turn } = await r.json();
    expect(turn).toMatchObject({ askedByRole: "buyer", topic: "compromise", pose: "tablet" });
    state.actor = owner;
    const g = await route.GET(new Request(`http://test/api/enquiries/${E}/assistant`), ctx(E));
    const body = await g.json();
    expect(body.role).toBe("owner");
    expect(body.persona.name).toBe("Elena");
    expect(body.viewerId).toBe(owner.userId);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].answer).toBe(turn.answer);
    expect(state.deps!.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "enquiry.assistant_asked" }));
  });

  it("non-parties get not_found and nothing is stored", async () => {
    state.actor = stranger;
    expect((await ask("Where do things stand?")).status).toBe(404);
    expect((await route.GET(new Request(`http://test/api/enquiries/${E}/assistant`), ctx(E))).status).toBe(404);
    expect(turns()).toHaveLength(0);
  });

  it("signed out is 401; a cross-site post is refused", async () => {
    expect((await ask("Hi")).status).toBe(401);
    state.actor = buyer;
    expect((await ask("Hi", { origin: "http://evil.example" })).status).toBe(403);
  });

  it("refuses contact details, discriminatory wording, missing terms and too many questions", async () => {
    state.actor = buyer;
    expect((await ask("Call me on 0412 345 678")).status).toBe(400);
    termsOk = false;
    expect((await ask("Where do things stand?")).status).toBe(403);
    termsOk = true;
    hits = 31;
    expect((await ask("Where do things stand?")).status).toBe(429);
    expect(turns()).toHaveLength(0);
  });

  it("a floor probe is answered safely and its safety category is audited", async () => {
    state.actor = buyer;
    const r = await ask("What is the lowest price the owner would accept?");
    const { turn } = await r.json();
    expect(turn.topic).toBe("privacy");
    expect(turn.answer).not.toMatch(/\$\d/);
    expect(state.deps!.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ safetyFlags: ["floor_probe"] }) }));
  });

  it("the service uses the offer from the deps, and getAssistantThread includes the facts", async () => {
    const t = await getAssistantThread(state.deps!, owner, E);
    expect(t.ok && t.value.facts.offer?.priceCents).toBe(108_000_000);
    const a = await askAssistant(state.deps!, owner, E, "What happens next?");
    expect(a.ok && a.value.askedByRole).toBe("owner");
  });

  it("answers small talk naturally and hands back to the work", () => {
    const say = (q: string) => chatAnswer(facts(), "buyer", q);
    expect(say("hi").text).toBe("Hi there! How's your day going?");
    expect(say("Hello!").topic).toBe("chitchat");
    expect(say("How's your day?").text).toContain("What can I do for you?");
    expect(say("how are you").text).toContain("I'm doing well");
    expect(say("I'm good thanks").text).toContain("Glad to hear it");
    expect(say("pretty tired today").text).toContain("Sorry to hear that");
    expect(say("who are you?").text).toContain("not a licensed agent");
    expect(say("thanks!").text).toContain("You're welcome");
    expect(say("bye").text).toContain("Bye for now");
    expect(say("hi").pose).toBe("wave");
    expect(chatWelcome(facts(), "Elena").text).toContain("What can I do for you?");
  });

  it("understands casual texting-style small talk", () => {
    const say = (q: string) => chatAnswer(facts(), "buyer", q);
    for (const q of ["how r u", "How R U?", "hru", "how ru", "how are u", "wbu", "hbu", "what about you", "and u", "how u doing", "hows life"]) {
      expect([q, say(q).topic, say(q).text]).toEqual([q, "chitchat", expect.stringContaining("I'm doing well")]);
    }
    for (const q of ["u", "yo", "yooo", "sup", "wassup", "wat up", "what up", "whats up", "hiii", "heyyy", "helloo", "gm", "morning", "hey there"]) {
      expect([q, say(q).text]).toEqual([q, "Hi there! How's your day going?"]);
    }
    expect(say("thnx").text).toContain("You're welcome");
    expect(say("tysm").text).toContain("You're welcome");
    expect(say("cya").text).toContain("Bye for now");
    expect(say("ttyl").text).toContain("Bye for now");
    expect(say("kk").text).toContain("What can I do for you?");
    expect(say("you owe me").topic).toBe("unknown");
  });

  it("keeps real questions and protected topics ahead of small talk", () => {
    expect(chatAnswer(facts(), "buyer", "hi, where do things stand?").topic).toBe("offer");
    expect(chatAnswer(facts(), "buyer", "hey what is the owner's phone number").topic).toBe("privacy");
    expect(chatAnswer(facts(), "buyer", "good deal?").topic).toBe("advice");
    expect(chatAnswer(facts(), "buyer", "banana").topic).toBe("unknown");
  });
});
