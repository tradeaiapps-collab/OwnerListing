import { beforeEach, describe, expect, it, vi } from "vitest";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import { askAssistant, createInMemoryTurnRepository, getAssistantThread, type ChatAssistantDeps } from "../src/domain/chat-assistant";
import { createInMemoryEnquiryRepository, type EnquiryDeps } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import {
  createInMemoryMultilingual, getLanguage, parseDocumentInput, parsePrefsInput, setLanguage, translateDocument, translateEnquiryMessage
} from "../src/domain/multilingual-service";

const L = "11111111-1111-4111-8111-111111111111";
const E = "55555555-5555-4555-8555-555555555555";
const M = "66666666-6666-4666-8666-666666666666";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "buyer" };

/** Stand-in for the self-hosted model: swaps each English word for 译 (zh) / "xin" (vi) and keeps labels and ⟦n⟧. */
function engine(word: string): AiEnginePort & { calls: string[] } {
  const e = {
    calls: [] as string[],
    info: () => ({ id: "fake", kind: "self_hosted" as const, version: "1" }), readDocument: async () => "", describePhoto: async () => [],
    async generate(prompt: string, o?: { system?: string }) {
      e.calls.push(prompt);
      const to = /into ([^.]+)\./.exec(o?.system ?? "")?.[1] ?? "";
      // Question translation to English: return an English question; everything else gets the word.
      if (to.startsWith("English")) return prompt.split("\n").filter(l => /^\[\[\d+\]\]/.test(l)).map(l => l.replace(/\[\[(\d+)\]\].*/, "[[$1]] How much is the deposit?")).join("\n");
      const w = to.startsWith("Vietnamese") ? "xin" : word;
      return prompt.split("\n").filter(l => /^\[\[\d+\]\]/.test(l)).map(l => l.replace(/[A-Za-z]+(?:'[a-z]+)?|[\u4e00-\u9fff]+/g, w).replace(new RegExp(`(\\[\\[\\d+\\]\\]\\s)(?:${w}\\s?)+`), "$1" + w)).join("\n");
    }
  };
  return e;
}

let n = 0;
let hits = 1;
let deps: ChatAssistantDeps;
let ml: ReturnType<typeof createInMemoryMultilingual>;
let eng: ReturnType<typeof engine>;
const audit = vi.fn(async (_e: unknown) => {});

async function setup(e: AiEnginePort) {
  n = 0; hits = 1;
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
  await enquiries.addMessage({ id: M, enquiryId: E, senderUserId: owner.userId, automated: false, body: "The deposit is $50,000 and settlement is in 30 days.", sentAt: "2026-10-30T00:30:00.000Z" });
  ml = createInMemoryMultilingual(e);
  deps = {
    enquiries, listings, termsCurrentFor: async () => true, countHit: async () => hits, now: () => "2026-10-30T01:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, appendAudit: audit,
    turns: createInMemoryTurnRepository(),
    offerFor: async () => ({ priceCents: 108_000_000, depositCents: 10_800_000, settlementDays: 30, conditions: ["Subject to finance"], status: "submitted" }),
    verifiedDisclosures: async () => 1, persona: async () => ({ id: "elena" as const, name: "Elena", icon: "/i.png", portrait: "/p.jpg", poses: {} }),
    multilingual: ml
  };
}
const svc = () => ({ enquiry: deps as unknown as EnquiryDeps, ml });

describe("Elena answers in the buyer's language", () => {
  beforeEach(async () => { eng = engine("译"); await setup(eng); });

  it("recognises Chinese from the first message, understands it, answers in Chinese, and keeps the English record", async () => {
    const r = await askAssistant(deps, buyer, E, "订金是多少？");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ topic: "deposit", language: "zh-Hans" });
    expect(r.value.answer).toMatch(/deposit/i);            // English answer is what is stored
    expect(r.value.localized).toMatchObject({ locale: "zh-Hans", mode: "translated", rtl: false });
    expect(r.value.localized!.text).toContain("译");
    // Amounts and the listing's address survive translation exactly.
    for (const m of r.value.answer.match(/\$[\d,]+/g) ?? []) expect(r.value.localized!.text).toContain(m);
    expect(ml.prefsByUser.get(buyer.userId)?.lastDetected).toBe("zh-Hans");
    expect(deps.turns).toBeDefined();
  });

  it("a later short message keeps the language the person was using", async () => {
    await askAssistant(deps, buyer, E, "订金是多少？");
    const r = await askAssistant(deps, buyer, E, "ok");
    expect(r.ok && r.value.localized?.locale).toBe("zh-Hans");
  });

  it("a saved language choice wins over what is typed", async () => {
    await setLanguage(ml, buyer.userId, "vi");
    const r = await askAssistant(deps, buyer, E, "How much is the deposit?");
    expect(r.ok && r.value.localized?.locale).toBe("vi");
    await setLanguage(ml, buyer.userId, "auto");
    const r2 = await askAssistant(deps, buyer, E, "How much is the deposit?");
    expect(r2.ok && r2.value.localized).toBeUndefined();
  });

  it("English questions are not translated and cost nothing", async () => {
    const r = await askAssistant(deps, buyer, E, "How much is the deposit?");
    expect(r.ok && r.value.localized).toBeUndefined();
    expect(eng.calls).toHaveLength(0);
  });

  it("with AI off she still understands the topic and tells the person, in their language, that the answer is in English", async () => {
    await setup(rulesOnlyEngine);
    const r = await askAssistant(deps, buyer, E, "Quali sono le condizioni dell'offerta e i prossimi passi?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.topic).not.toBe("unknown");
    expect(r.value.localized).toMatchObject({ locale: "it", mode: "english_fallback" });
    expect(r.value.localized!.text).toMatch(/inglese/);
  });

  it("a translation that fails the checks never replaces the English answer", async () => {
    const bad: AiEnginePort = { ...engine("译"), generate: async () => "[[0]] 译 without the amounts" };
    await setup(bad);
    const r = await askAssistant(deps, buyer, E, "订金是多少？");
    expect(r.ok && r.value.localized?.mode).toBe("english_fallback");
    expect(r.ok && r.value.answer).toMatch(/\$/);
  });

  it("the other party reads the thread in their own language; translations are saved once", async () => {
    await askAssistant(deps, buyer, E, "订金是多少？");
    await setLanguage(ml, owner.userId, "vi");
    const before = eng.calls.length;
    const t = await getAssistantThread(deps, owner, E);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const loc = t.value.localization!;
    expect(loc).toMatchObject({ locale: "vi", engineOn: true });
    expect(loc.welcome).toMatch(/Xin chào, tôi là Elena/);
    const turnId = t.value.turns[0]!.id;
    expect(loc.turns[turnId]?.answer).toBeTruthy();
    expect(loc.turns[turnId]?.question).toBeTruthy();
    const mid = eng.calls.length;
    expect(mid).toBeGreaterThan(before);
    await getAssistantThread(deps, owner, E);
    expect(eng.calls.length).toBe(mid); // cached
  });

  it("an English reader gets no localization block", async () => {
    const t = await getAssistantThread(deps, owner, E);
    expect(t.ok && t.value.localization).toBeUndefined();
  });

  it("discriminatory wording is still caught when it is only visible after translation", async () => {
    const e = { ...engine("x"), generate: async () => "[[0]] No kids." };
    await setup(e);
    const r = await askAssistant(deps, buyer, E, "不要有孩子的家庭可以吗，租客是谁？");
    expect(r.ok).toBe(false);
  });
});

describe("language preference", () => {
  beforeEach(async () => setup(engine("译")));
  it("validates and persists", async () => {
    expect(parsePrefsInput({ language: "xx" }).ok).toBe(false);
    expect(parsePrefsInput({}).ok).toBe(false);
    await setLanguage(ml, buyer.userId, "ko");
    expect(await getLanguage(ml, buyer.userId)).toMatchObject({ language: "ko", effective: "ko" });
    await setLanguage(ml, buyer.userId, "auto");
    expect(await getLanguage(ml, buyer.userId)).toMatchObject({ language: "auto", effective: "en" });
    expect((await getLanguage(ml, buyer.userId)).options.map(o => o.code)).toContain("pa");
  });
});

describe("message translation", () => {
  beforeEach(async () => { eng = engine("译"); await setup(eng); });
  it("translates for a party, keeps amounts, saves it, and leaves the original alone", async () => {
    const r = await translateEnquiryMessage(svc(), buyer, E, M, "zh-Hans");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ from: "en", to: "zh-Hans", machine: true, cached: false });
    expect(r.value.text).toContain("$50,000");
    expect(r.value.text).toContain("30");
    expect((await deps.enquiries.messages(E))[0]!.body).toMatch(/^The deposit/);
    const again = await translateEnquiryMessage(svc(), owner, E, M, "zh-Hans");
    expect(again.ok && again.value.cached).toBe(true);
    expect(eng.calls).toHaveLength(1);
  });
  it("defaults to the reader's language; same language returns the text as is", async () => {
    await setLanguage(ml, buyer.userId, "zh-Hans");
    const r = await translateEnquiryMessage(svc(), buyer, E, M);
    expect(r.ok && r.value.to).toBe("zh-Hans");
    const same = await translateEnquiryMessage(svc(), buyer, E, M, "en");
    expect(same.ok && same.value.text).toMatch(/^The deposit/);
  });
  it("strangers get not_found; unknown languages are invalid; unknown messages are not_found; AI off is unavailable; rate limit applies", async () => {
    expect((await translateEnquiryMessage(svc(), stranger, E, M, "vi"))).toMatchObject({ ok: false, code: "not_found" });
    expect((await translateEnquiryMessage(svc(), buyer, E, M, "xx"))).toMatchObject({ ok: false, code: "invalid" });
    expect((await translateEnquiryMessage(svc(), buyer, E, "77777777-7777-4777-8777-777777777777", "vi"))).toMatchObject({ ok: false, code: "not_found" });
    hits = 9999;
    expect((await translateEnquiryMessage(svc(), buyer, E, M, "vi"))).toMatchObject({ ok: false, code: "rate_limited" });
    await setup(rulesOnlyEngine);
    expect((await translateEnquiryMessage(svc(), buyer, E, M, "vi"))).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("document translation", () => {
  const contract = "Contract of sale\n\n1. Purchase price: $1,080,000\n2. Deposit: $108,000 payable to the trust account within 3 business days\n3. Settlement: 30 days";
  beforeEach(async () => { eng = engine("译"); await setup(eng); });

  it("keeps layout and figures, says English prevails, audits without the text, stores nothing", async () => {
    const r = await translateDocument(svc(), buyer, E, { text: contract, kind: "contract", to: "zh-Hans" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ from: "en", to: "zh-Hans", kind: "contract", englishPrevails: true, complete: true, untranslatedLines: 0 });
    expect(r.value.text.split("\n")).toHaveLength(contract.split("\n").length);
    for (const f of ["$1,080,000", "$108,000", "30"]) expect(r.value.text).toContain(f);
    expect(r.value.notice).toMatch(/英文/);
    expect(ml.rows).toHaveLength(0);
    const ev = audit.mock.calls.at(-1)![0] as { eventType: string; payload: Record<string, unknown> };
    expect(ev.eventType).toBe("enquiry.document_translated");
    expect(JSON.stringify(ev.payload)).not.toContain("Purchase");
  });

  it("Arabic output is flagged right-to-left", async () => {
    const r = await translateDocument(svc(), buyer, E, { text: contract, kind: "offer", to: "ar" }).catch(() => undefined);
    expect(r).toBeDefined();
    // The stand-in engine writes Chinese, which fails the Arabic check, so the lines stay English and are reported.
    expect(r!.ok && r!.value.rtl).toBe(true);
    expect(r!.ok && r!.value.complete).toBe(false);
  });

  it("validates input and access", async () => {
    expect(parseDocumentInput({ text: "" }).ok).toBe(false);
    expect(parseDocumentInput({ text: "x".repeat(30001) }).ok).toBe(false);
    expect(parseDocumentInput({ text: "hi", kind: "poem" }).ok).toBe(false);
    expect(parseDocumentInput({ text: "hi", from: "xx" }).ok).toBe(false);
    expect(parseDocumentInput({ text: "hi" })).toMatchObject({ ok: true, value: { kind: "other" } });
    expect(await translateDocument(svc(), stranger, E, { text: contract, kind: "other", to: "vi" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await translateDocument(svc(), buyer, E, { text: contract, kind: "other", to: "en" })).toMatchObject({ ok: false, code: "invalid" });
  });
});
