import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiEnginePort } from "../src/domain/ai-engine";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import {
  aiAssistant, DEFAULT_GUIDE, GUIDE_DISCLAIMER, GUIDE_INTENTS, guideAnswer, guideLink, guidePage, matchIntent, parseStoredGuide,
  rulesAssistant, selectAssistantEngine, suggestedChips, validateGuideContent, type GuideContent, type GuideQuery
} from "../src/domain/guide-assistant";
import { buyerChecklist, nextStep, ownerChecklist, progress } from "../src/domain/journey";
import { DEFAULT_THEME, parseStoredTheme, validateTheme, buildThemeCss } from "../src/domain/site-theme";
import { inspectSiteAsset } from "../src/domain/site-asset";
import { staffCan } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";

const state = vi.hoisted(() => ({
  actor: null as null | { userId: string; userType: string },
  staff: null as null | { id: string; role: string },
  queries: [] as { sql: string; params: unknown[] }[],
  hits: 1 as number | "throw",
  guide: null as unknown,
  saved: [] as unknown[],
  published: [] as unknown[]
}));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor,
  getStaff: async () => state.staff,
  getDb: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      state.queries.push({ sql, params });
      if (sql.includes("offer_submit_attempt")) {
        if (state.hits === "throw") throw new Error("db down");
        return { rows: [{ hits: state.hits }] };
      }
      return { rows: [] };
    }
  })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/ai", async () => ({ getAiEngine: async () => (await import("../src/domain/ai-engine")).rulesOnlyEngine }));
vi.mock("../src/server/journey", () => ({
  loadJourney: async () => ({ role: "owner", steps: ownerChecklist({ termsAccepted: true, listingCount: 0, focusListingId: null, photoCount: 0, planChosen: false, published: false }) })
}));
vi.mock("../src/server/guide-assistant-db", async () => {
  const { DEFAULT_GUIDE: D } = await import("../src/domain/guide-assistant");
  const view = () => ({ draftVersion: 3, liveVersion: 2, draft: D, live: D, versions: [] });
  return {
    getLiveGuide: async () => (state.guide ?? D),
    loadGuideView: async () => view(),
    saveGuideDraft: async (_db: unknown, _s: unknown, base: unknown, c: unknown) => { state.saved.push({ base, c }); return { ok: true, version: 4 }; },
    publishGuide: async (_db: unknown, _s: unknown, v: unknown) => { state.published.push(v); return { ok: true, version: v }; }
  };
});

import * as assistantRoute from "../app/api/assistant/route";
import * as staffRoute from "../app/api/staff/assistant/route";
import * as publishRoute from "../app/api/staff/assistant/publish/route";

const q = (o: Partial<GuideQuery>): GuideQuery => ({ path: "/", user: "signed_out", ...o });
const content = (f?: (c: GuideContent) => void) => { const c = structuredClone(DEFAULT_GUIDE); f?.(c); return c; };

describe("guide content validation", () => {
  it("accepts the defaults and round-trips them", () => {
    expect(validateGuideContent(DEFAULT_GUIDE)).toEqual({ ok: true, value: DEFAULT_GUIDE });
    expect(parseStoredGuide(JSON.stringify(DEFAULT_GUIDE))).toEqual(DEFAULT_GUIDE);
  });
  it("refuses HTML, braces, over-long text, unknown fields and bad links", () => {
    const bad = (f: (c: Record<string, any>) => void) => { const c = structuredClone(DEFAULT_GUIDE) as Record<string, any>; f(c); return validateGuideContent(c); };
    expect(bad(c => { c.greeting = "<script>alert(1)</script>"; })).toMatchObject({ ok: false, errors: { greeting: expect.any(String) } });
    expect(bad(c => { c.greeting = "x".repeat(301); })).toMatchObject({ ok: false });
    expect(bad(c => { c.faq.fees.answer = "{{constructor}}"; })).toMatchObject({ ok: false });
    expect(bad(c => { c.faq.fees.answer = "a`b"; })).toMatchObject({ ok: false });
    expect(bad(c => { c.extra = 1; })).toMatchObject({ ok: false, errors: { extra: "Unknown field." } });
    expect(bad(c => { delete c.faq.offers; })).toMatchObject({ ok: false });
    expect(bad(c => { c.chips = [...c.chips, { intent: "fees", label: "again" }]; })).toMatchObject({ ok: false });
    expect(bad(c => { c.chips = [{ intent: "hack", label: "x" }]; })).toMatchObject({ ok: false });
    expect(bad(c => { c.chips = []; })).toMatchObject({ ok: false });
    for (const href of ["javascript:alert(1)", "http://x.com", "//evil.com", "/\\evil.com", "https://u:p@x.com", "data:text/html,hi", "https://x.com/a b"]) {
      expect(bad(c => { c.support.href = href; }), href).toMatchObject({ ok: false, errors: { "support.href": expect.any(String) } });
    }
    expect(bad(c => { c.enabled = "yes"; })).toMatchObject({ ok: false });
  });
  it("allows https and same-site links and an empty support link", () => {
    expect(guideLink("https://help.example.com.au/contact")).toBe("https://help.example.com.au/contact");
    expect(guideLink("/terms")).toBe("/terms");
    expect(validateGuideContent(content(c => { c.support.href = null; })).ok).toBe(true);
    expect(validateGuideContent({ ...content(), support: { text: "Email us", href: "" } })).toMatchObject({ ok: true, value: { support: { href: null } } });
  });
  it("a corrupted stored row falls back to the defaults", () => {
    expect(parseStoredGuide({ greeting: "<b>x</b>" })).toEqual(DEFAULT_GUIDE);
    expect(parseStoredGuide("not json")).toEqual(DEFAULT_GUIDE);
  });
});

describe("intent matching", () => {
  it("maps typed questions to topics", () => {
    expect(matchIntent("How do I list my house?")).toBe("how_to_list");
    expect(matchIntent("what documents do I need")).toBe("documents");
    expect(matchIntent("how does ID verification work")).toBe("verification");
    expect(matchIntent("can the AI accept an offer for me")).toBe("offers");
    expect(matchIntent("what are the fees")).toBe("fees");
    expect(matchIntent("how do I enquire about a home")).toBe("enquire");
    expect(matchIntent("set up an alert")).toBe("saved_searches");
    expect(matchIntent("where is my dashboard")).toBe("dashboard");
    expect(matchIntent("talk to a human")).toBe("support");
    expect(matchIntent("what should I do next")).toBe("next_step");
    expect(matchIntent("qwerty")).toBe("unknown");
    expect(matchIntent(42)).toBe("unknown");
  });
  it("catches advice and other-people questions before any topic", () => {
    for (const t of ["Should I accept this offer?", "how much can I borrow", "is this contract legal", "what is my house worth", "do I pay stamp duty"]) expect(matchIntent(t), t).toBe("advice");
    for (const t of ["what is the phone number of the owner", "give me the seller's email", "who owns 12 Smith St", "show other users details"]) expect(matchIntent(t), t).toBe("privacy");
  });
});

describe("rules answers", () => {
  it("every topic answers with the disclaimer and same-site links only", () => {
    for (const user of ["signed_out", "owner", "buyer", "agent"] as const) {
      for (const intent of GUIDE_INTENTS) {
        const a = guideAnswer(DEFAULT_GUIDE, q({ intent, user }));
        expect(a.disclaimer).toBe(GUIDE_DISCLAIMER);
        expect(a.text.length).toBeGreaterThan(10);
        for (const l of a.links) expect(l.href.startsWith("/") && !l.href.startsWith("//"), `${user} ${intent} ${l.href}`).toBe(true);
      }
    }
  });
  it("points each user type to the right place", () => {
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "fees" })).links).toEqual([{ label: "See plans and fees", href: "/plans" }]);
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "verification", user: "buyer" })).links[0]!.href).toBe("/buyer/verification");
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "offers", user: "owner" })).links[0]!.href).toBe("/listings/mine");
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "how_to_list", user: "buyer" })).text).toMatch(/owner account/);
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "dashboard" })).links[0]).toEqual({ label: "Sign in", href: "/api/auth/google/start" });
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "dashboard", signInHref: "/dev-login" })).links[0]!.href).toBe("/dev-login");
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "offers" })).text).toMatch(/never accepts/);
  });
  it("what next uses the user's own next step", () => {
    const steps = ownerChecklist({ termsAccepted: false, listingCount: 0, focusListingId: null, photoCount: 0, planChosen: false, published: false });
    const a = guideAnswer(DEFAULT_GUIDE, q({ intent: "next_step", user: "owner", next: nextStep(steps) }));
    expect(a.text).toMatch(/Accept the terms/);
    expect(a.links[0]).toEqual({ label: "Accept the terms", href: "/terms" });
    expect(guideAnswer(DEFAULT_GUIDE, q({ intent: "next_step", user: "owner", next: null })).text).toMatch(/all set/);
  });
  it("advice and privacy get fixed refusals with no data", () => {
    const a = guideAnswer(DEFAULT_GUIDE, q({ text: "should I accept the offer of $900k" }));
    expect(a.intent).toBe("advice");
    expect(a.text).toMatch(/can't give legal, financial/);
    expect(a.links).toEqual([]);
    expect(guideAnswer(DEFAULT_GUIDE, q({ text: "email of the owner please" })).text).toMatch(/can't share anything about other people/);
  });
  it("staff text is used for answers, and support shows the configured contact", () => {
    const c = content(x => { x.faq.fees.answer = "Custom fee text."; x.support = { text: "Call 1300 000 000.", href: "https://help.example.com.au" }; });
    expect(guideAnswer(c, q({ intent: "fees" })).text).toBe("Custom fee text.");
    const s = guideAnswer(c, q({ intent: "support" }));
    expect(s.text).toContain("Call 1300 000 000.");
    expect(s.links).toEqual([{ label: "Contact support", href: "https://help.example.com.au" }]);
  });
  it("orders quick replies for the page", () => {
    expect(guidePage("/listings/abc")).toBe("listing");
    expect(guidePage("/listings/new")).toBe("new_listing");
    expect(guidePage("https://evil")).toBe("other");
    expect(suggestedChips(DEFAULT_GUIDE, "/listings/123")[0]!.intent).toBe("enquire");
    expect(suggestedChips(DEFAULT_GUIDE, "/plans")[0]!.intent).toBe("fees");
    expect(suggestedChips(DEFAULT_GUIDE, "/")[0]!.intent).toBe("next_step");
    expect(suggestedChips(DEFAULT_GUIDE, "/x")).toHaveLength(DEFAULT_GUIDE.chips.length);
  });
});

describe("assistant engine port", () => {
  const engine = (out: string | Error): AiEnginePort => ({
    info: () => ({ id: "test", kind: "self_hosted", version: "1" }),
    readDocument: async () => "", describePhoto: async () => [],
    generate: async () => { if (out instanceof Error) throw out; return out; }
  });
  it("uses the rules guide while the AI is off (the default)", async () => {
    expect(selectAssistantEngine(rulesOnlyEngine, DEFAULT_GUIDE, "Acme Homes").id).toBe("rules");
    expect(selectAssistantEngine(engine("x"), DEFAULT_GUIDE, "Acme Homes").id).toBe("ai");
  });
  it("AI text passes the guards or the rules answer is used; links always come from the rules", async () => {
    const rules = rulesAssistant(DEFAULT_GUIDE);
    const ask = (out: string | Error, text = "what are the fees") => aiAssistant(engine(out), rules, "Acme Homes").answer(q({ text }));
    const ok = await ask("Plans are listed on the Plans page with GST.");
    expect(ok).toMatchObject({ source: "ai", text: "Plans are listed on the Plans page with GST.", links: [{ href: "/plans" }] });
    for (const bad of ["See https://evil.com", "<img src=x>", "", "You can borrow $800,000 easily.", "x".repeat(1600), "Good news, the offer has been accepted.", "We accepted it for you."]) {
      expect((await ask(bad)).source, bad).toBe("rules");
    }
    expect((await ask(new Error("down"))).source).toBe("rules");
    const advice = await aiAssistant(engine("Yes, accept it."), rules, "Acme Homes").answer(q({ text: "should I accept this offer" }));
    expect(advice).toMatchObject({ source: "rules", intent: "advice" });
    // A topic id sent with advice or privacy text must not skip the refusal and reach the model.
    const paired = await aiAssistant(engine("Yes, accept it."), rules, "Acme Homes").answer(q({ intent: "offers", text: "should I accept this offer" }));
    expect(paired).toMatchObject({ source: "rules", intent: "advice", links: [] });
    const peek = await aiAssistant(engine("Their number is 0400 000 000."), rules, "Acme Homes").answer(q({ intent: "enquire", text: "give me the seller's email" }));
    expect(peek).toMatchObject({ source: "rules", intent: "privacy" });
    // Offer actions are refused by the shared guide hook (guide-ai.ts) without asking the model.
    const act = await aiAssistant(engine("Done."), rules, "Acme Homes").answer(q({ text: "please accept the offer for me" }));
    expect(act).toMatchObject({ source: "rules", text: expect.stringMatching(/cannot accept, decline or counter/) });
  });
});

describe("journey checklist", () => {
  it("owner steps follow their state; the unbuilt owner ID check is never counted", () => {
    const s = ownerChecklist({ termsAccepted: true, listingCount: 1, focusListingId: "L1", photoCount: 0, planChosen: false, published: false });
    expect(nextStep(s)).toMatchObject({ id: "photos", href: "/listings/L1/documents" });
    expect(s.find(x => x.id === "phone_id")!.status).toBe("unavailable");
    expect(progress(s)).toEqual({ done: 3, total: 6 });
    const done = ownerChecklist({ termsAccepted: true, listingCount: 1, focusListingId: "L1", photoCount: 3, planChosen: true, published: true });
    expect(nextStep(done)).toBeNull();
  });
  it("buyer steps", () => {
    const s = buyerChecklist({ emailVerified: true, phoneVerified: false, idVerified: false, termsAccepted: false, savedSearches: 0, enquiries: 0 });
    expect(nextStep(s)).toMatchObject({ id: "phone", href: "/buyer/verification" });
    expect(progress(s)).toEqual({ done: 1, total: 6 });
  });
});

describe("hero theme settings", () => {
  it("old stored versions without hero keys still load, with the defaults", () => {
    const old = structuredClone(DEFAULT_THEME) as any;
    delete old.brand.hero; delete old.layout.heroOverlay; delete old.layout.heroFocus;
    old.brand.siteName = "Kept";
    const t = parseStoredTheme(old);
    expect(t.brand).toMatchObject({ siteName: "Kept", hero: null });
    expect(t.layout).toMatchObject({ heroOverlay: 55, heroFocus: 50 });
  });
  it("the overlay cannot go below 45% and is written as a CSS number", () => {
    const t = structuredClone(DEFAULT_THEME);
    t.layout.heroOverlay = 30;
    expect(validateTheme(t)).toMatchObject({ ok: false, errors: { "layout.heroOverlay": expect.any(String) } });
    t.layout.heroOverlay = 70;
    expect(buildThemeCss(t)).toContain("--hero-overlay:0.7;");
    expect(buildThemeCss(t)).toContain("--hero-focus:50%;");
  });
  it("the hero slot has its own size rules", () => {
    const png = (w: number, h: number) => { const b = Buffer.alloc(120); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
    expect(inspectSiteAsset("hero", "image/png", png(2400, 1200))).toMatchObject({ ok: true });
    expect(inspectSiteAsset("hero", "image/png", png(1199, 600))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("hero", "image/png", png(1200, 1300))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", png(2400, 1200))).toMatchObject({ ok: false });
  });
});

describe("staff permissions", () => {
  it("editing needs site.content.edit and publishing site.content.publish; designers cannot", () => {
    expect(staffCan({ id: "a", role: "super_admin" }, "site.content.edit")).toBe(true);
    expect(staffCan({ id: "a", role: "designer" }, "site.content.edit")).toBe(false);
    expect(sectionsFor({ id: "a", role: "super_admin" }).map(s => s.href)).toContain("/staff/assistant");
    expect(sectionsFor({ id: "a", role: "designer" }).map(s => s.href)).not.toContain("/staff/assistant");
    expect(sectionsFor({ id: "a", role: "custom_web", permissions: ["site.content.edit"] }).map(s => s.href)).toContain("/staff/assistant");
  });
});

const ORIGIN = "http://test";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/assistant`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "203.0.113.9", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /api/assistant", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env["APP_URL"]; process.env["APP_URL"] = ORIGIN; state.actor = null; state.queries = []; state.hits = 1; state.guide = null; });
  afterEach(() => { if (saved === undefined) delete process.env["APP_URL"]; else process.env["APP_URL"] = saved; });

  it("answers a topic and never stores or logs the typed text", async () => {
    const secret = "my bank account is 062-000 12345678 how do fees work";
    const r = await assistantRoute.POST(post({ text: secret, path: "/plans" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ intent: "fees", links: [{ href: "/plans" }], disclaimer: GUIDE_DISCLAIMER });
    // The only database statement is the rate-limit counter, keyed by a hash of the IP (no raw IP, no text).
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]!.sql).toContain("offer_submit_attempt");
    expect(JSON.stringify(state.queries)).not.toContain("12345678");
    expect(JSON.stringify(state.queries)).not.toContain("203.0.113.9");
  });
  it("is rate limited and fails closed", async () => {
    state.hits = 61;
    expect((await assistantRoute.POST(post({ intent: "fees", path: "/" }))).status).toBe(429);
    state.hits = "throw";
    expect((await assistantRoute.POST(post({ intent: "fees", path: "/" }))).status).toBe(503);
  });
  it("refuses cross-site posts, bad input and oversized bodies", async () => {
    expect((await assistantRoute.POST(post({ intent: "fees", path: "/" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await assistantRoute.POST(post({ intent: "steal", path: "/" }))).status).toBe(400);
    expect((await assistantRoute.POST(post({ text: "x".repeat(501), path: "/" }))).status).toBe(400);
    expect((await assistantRoute.POST(post({ path: "/" }))).status).toBe(400);
    expect((await assistantRoute.POST(post("[1]"))).status).toBe(400);
    expect((await assistantRoute.POST(post(JSON.stringify({ text: "a".repeat(3000) })))).status).toBe(413);
  });
  it("what next reads only the signed-in user's own journey", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    const r = await assistantRoute.POST(post({ intent: "next_step", path: "/dashboard" }));
    expect(await r.json()).toMatchObject({ text: expect.stringMatching(/Create your listing/), links: [{ href: "/listings/new" }, { href: "/dashboard" }] });
  });
  it("answers 404 while staff have switched the guide off", async () => {
    state.guide = content(c => { c.enabled = false; });
    expect((await assistantRoute.POST(post({ intent: "fees", path: "/" }))).status).toBe(404);
  });
});

describe("staff /api/staff/assistant", () => {
  let saved: string | undefined;
  const req = (method: string, body?: unknown) => new Request(`${ORIGIN}/api/staff/assistant`, { method, headers: { "content-type": "application/json", origin: ORIGIN }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  beforeEach(() => { saved = process.env["APP_URL"]; process.env["APP_URL"] = ORIGIN; state.staff = null; state.saved = []; state.published = []; });
  afterEach(() => { if (saved === undefined) delete process.env["APP_URL"]; else process.env["APP_URL"] = saved; });

  it("needs staff with the content permissions", async () => {
    expect((await staffRoute.GET(req("GET"))).status).toBe(401);
    state.staff = { id: "s1", role: "designer" };
    expect((await staffRoute.GET(req("GET"))).status).toBe(403);
    expect((await staffRoute.PUT(req("PUT", { baseVersion: 3, content: DEFAULT_GUIDE }))).status).toBe(403);
    expect((await publishRoute.POST(req("POST", { version: 3 }))).status).toBe(403);
    state.staff = { id: "s1", role: "custom_editor", permissions: ["site.content.edit"] } as never;
    expect((await staffRoute.PUT(req("PUT", { baseVersion: 3, content: DEFAULT_GUIDE }))).status).toBe(200);
    expect((await publishRoute.POST(req("POST", { version: 4 }))).status).toBe(403);
    expect(state.published).toEqual([]);
  });
  it("validates before saving and publishes the reviewed version", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    const r = await staffRoute.PUT(req("PUT", { baseVersion: 3, content: { ...DEFAULT_GUIDE, greeting: "<b>hi</b>" } }));
    expect(r.status).toBe(400);
    expect((await r.json()).fields).toHaveProperty("greeting");
    expect((await staffRoute.PUT(req("PUT", { baseVersion: "x", content: DEFAULT_GUIDE }))).status).toBe(400);
    expect(state.saved).toEqual([]);
    expect((await staffRoute.PUT(req("PUT", { baseVersion: 3, content: DEFAULT_GUIDE }))).status).toBe(200);
    expect((await publishRoute.POST(req("POST", { version: 4 }))).status).toBe(200);
    expect(state.published).toEqual([4]);
  });
});
