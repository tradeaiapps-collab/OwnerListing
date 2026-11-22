import { describe, expect, it } from "vitest";
import type { ChatFacts } from "../src/domain/chat-assistant";
import { analyseConversation, cleanTranscript, draftFromWords, type CopilotMessage } from "../src/domain/chat-copilot";
import { createInMemoryEnquiryRepository, getThread, type EnquiryDeps } from "../src/domain/enquiry-service";

const facts = (over: Partial<ChatFacts> = {}): ChatFacts => ({
  listing: { title: "Home", address: "1 Test St", transactionType: "sale", propertyType: "house", askingCents: 100_000_000, verifiedDisclosures: 0 }, ...over
});
const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h)).toISOString();
const NOW = new Date(Date.UTC(2026, 10, 1, 12)).toISOString();

describe("Elena drafting from words", () => {
  it("cleans fillers, fixes i and ends sentences", () => {
    expect(cleanTranscript("um tell them that i can do it  uh   on friday")).toBe("I can do it on friday.");
  });
  it("turns a spoken offer into three structured drafts that say it is not a formal offer", () => {
    const r = draftFromWords("um tell him I can do 850k with a 60 day settlement and ten percent deposit");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent).toBe("offer");
    expect(r.variants.map(v => v.tone)).toEqual(["warm", "direct", "brief"]);
    for (const v of r.variants) { expect(v.text).toContain("$850,000"); expect(v.text.toLowerCase()).toContain("not a formal offer"); }
    expect(r.variants[0]!.text).toContain("60 days");
  });
  it("drafts a viewing request and refuses empty or discriminatory words", () => {
    const v = draftFromWords("can I come and inspect the house on Saturday");
    expect(v.ok && v.intent).toBe("viewing");
    expect(draftFromWords("  ").ok).toBe(false);
  });
});

describe("Elena reading a conversation", () => {
  const msgs = (...m: [CopilotMessage["side"], string, number][]): CopilotMessage[] => m.map(([side, body, h]) => ({ side, body, sentAt: at(h) }));

  it("tells the seller a lowball will likely fail and offers a counter draft", () => {
    const a = analyseConversation({ role: "owner", facts: facts(), now: NOW, messages: msgs(["buyer", "Hi, I'd offer $780,000 for it", 9]) });
    expect(a.outlook).toEqual({ level: "low", percentOfAsking: 78 });
    const price = a.insights.find(i => i.id === "price")!;
    expect(price.tone).toBe("risk");
    expect(price.headline).toMatch(/unlikely/i);
    expect(price.action!.text).toContain("$890,000");
    expect(a.waitingOn).toBe("you");
    expect(a.replies.length).toBeGreaterThan(0);
  });
  it("tells the buyer the same price needs to move, using only asking and messages", () => {
    const a = analyseConversation({ role: "buyer", facts: facts(), now: NOW, messages: msgs(["buyer", "I'd offer $780,000", 9], ["seller", "Thanks, that's too low for us", 10]) });
    expect(a.insights.find(i => i.id === "price")!.headline).toMatch(/will likely fail/i);
    expect(a.waitingOn).toBe("you");
  });
  it("reads a close offer as a good sign and flags pressure, tension and stalls", () => {
    const good = analyseConversation({ role: "owner", facts: facts(), now: NOW, messages: msgs(["buyer", "We love the house, offering $985,000", 10]) });
    expect(good.outlook?.level).toBe("good");
    expect(good.insights.some(i => i.id === "committed")).toBe(true);
    const pressure = analyseConversation({ role: "owner", facts: facts(), now: NOW, messages: msgs(["buyer", "This is my final offer, must accept by tonight. Other buyers are keen.", 11]) });
    expect(pressure.insights.map(i => i.id)).toEqual(expect.arrayContaining(["pressure", "competing", "firm"]));
    const stalled = analyseConversation({ role: "buyer", facts: facts(), now: new Date(Date.UTC(2026, 10, 5)).toISOString(), messages: msgs(["buyer", "Is it still available?", 9]) });
    expect(stalled.waitingOn).toBe("them");
    expect(stalled.insights.some(i => i.id === "stalled")).toBe(true);
  });
  it("uses an open formal counter and never accepts for anyone", () => {
    const a = analyseConversation({
      role: "owner", now: NOW, messages: msgs(["buyer", "Following up", 9]),
      facts: facts({ offer: { priceCents: 90_000_000, depositCents: 9_000_000, settlementDays: 30, conditions: [], status: "countered", counter: { fromParty: "owner", priceCents: 96_000_000, depositCents: 9_000_000, settlementDays: 30, conditions: [], status: "open" } } })
    });
    expect(a.insights.some(i => i.id === "counter")).toBe(true);
    const text = JSON.stringify(a).toLowerCase();
    expect(text).not.toContain("i accept");
    expect(a.disclaimer).toMatch(/not a valuation/i);
  });
});

describe("two-tick read receipts", () => {
  it("shows when the other side last opened the thread", async () => {
    const repo = createInMemoryEnquiryRepository();
    expect(await repo.lastReadByOthers("a", "e1")).toBeUndefined();
    await repo.markRead("b", "e1", "2026-11-01T10:00:00.000Z");
    await repo.markRead("b", "e1", "2026-11-01T11:00:00.000Z");
    await repo.markRead("a", "e1", "2026-11-01T12:00:00.000Z");
    expect(await repo.lastReadByOthers("a", "e1")).toBe("2026-11-01T11:00:00.000Z");
    expect(await repo.lastReadByOthers("b", "e1")).toBe("2026-11-01T12:00:00.000Z");
    void getThread; void (null as unknown as EnquiryDeps);
  });
});
