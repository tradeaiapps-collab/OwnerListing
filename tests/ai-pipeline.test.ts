import { describe, expect, it } from "vitest";
import {
  AI_FOOTER, hasFooter, inQuietHours, inputHash, nextSendTime, parseModelJson, PROMPT_VERSIONS, stripFooter, withFooter, wordingFilterNotInstalled
} from "../src/domain/ai-pipeline";
import { amountsInText, guardDraft, type DraftGuardContext } from "../src/domain/ai-output-guard";

const clean = () => ({ blocked: false, flags: [], installed: true });
const ctx = (o: Partial<DraftGuardContext> = {}): DraftGuardContext => ({ wordingFilter: clean, allowedAmountsCents: [85_000_000], ...o });

describe("AI pipeline helpers", () => {
  it("footer is added once and can be stripped for editing", () => {
    const t = withFooter("Thanks for your message.");
    expect(t.endsWith(AI_FOOTER)).toBe(true);
    expect(withFooter(t)).toBe(t);
    expect(hasFooter(t)).toBe(true);
    expect(stripFooter(t)).toBe("Thanks for your message.");
  });
  it("input hash is stable, depends on every part and on the prompt version", () => {
    const a = inputHash(PROMPT_VERSIONS.enquiryReply, "x", "y");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(inputHash(PROMPT_VERSIONS.enquiryReply, "x", "y")).toBe(a);
    expect(inputHash(PROMPT_VERSIONS.enquiryReply, "xy")).not.toBe(a);
    expect(inputHash(PROMPT_VERSIONS.offerResponse, "x", "y")).not.toBe(a);
  });
  it("quiet hours use the property's state time (8pm to 8am)", () => {
    // 2026-10-25 10:30 UTC = 20:30 in Brisbane (UTC+10, no daylight saving), 21:30 in Sydney (UTC+11), 18:30 in Perth.
    const t = "2026-10-25T10:30:00.000Z";
    expect(inQuietHours(t, "QLD")).toBe(true);
    expect(inQuietHours(t, "NSW")).toBe(true);
    expect(inQuietHours(t, "WA")).toBe(false);
    expect(inQuietHours("2026-10-25T02:00:00.000Z", "QLD")).toBe(false); // noon in Brisbane
    expect(nextSendTime(t, "QLD")).toBe("2026-10-25T22:00:00.000Z"); // 8am Brisbane next day
    expect(nextSendTime(t, "WA")).toBe(t);
  });
  it("parses only a JSON object out of model text", () => {
    expect(parseModelJson('Sure! {"a": 1} done')).toEqual({ a: 1 });
    expect(parseModelJson("[1,2]")).toBeUndefined();
    expect(parseModelJson("no json")).toBeUndefined();
    expect(parseModelJson("{bad json}")).toBeUndefined();
  });
});

describe("draft guard", () => {
  it("passes a plain, factual draft", () => {
    expect(guardDraft(withFooter("Thanks for asking. The asking price is $850,000. The owner will confirm inspection times."), ctx())).toEqual({ ok: true, violations: [] });
  });
  it("fails closed when the wording filter is not installed", () => {
    const r = guardDraft("Thanks for asking.", ctx({ wordingFilter: wordingFilterNotInstalled }));
    expect(r.ok).toBe(false);
    expect(r.violations.map(v => v.code)).toEqual(["wording_filter_missing"]);
  });
  it("blocks wording-filter hits", () => {
    const r = guardDraft("Suits professionals only.", ctx({ wordingFilter: () => ({ blocked: true, flags: [{ category: "occupation", match: "professionals only" }], installed: true }) }));
    expect(r.violations.map(v => v.code)).toContain("wording_filter");
  });
  it.each([
    ["We accept your offer of $850,000.", "binding_language"],
    ["Great news, the property is yours.", "binding_language"],
    ["It's a deal!", "binding_language"],
    ["Deal, it's yours.", "binding_language"],
    ["The owner has agreed to sell to you.", "binding_language"],
    ["Our reserve price is firm.", "floor_leak"],
    ["The lowest the owner will accept is close to asking.", "floor_leak"],
    ["There are other offers on the table.", "other_buyers"],
    ["Act now, this won't last.", "false_urgency"],
    ["Call me on 0412 345 678.", "contact_details"],
    ["See www.example.com", "contact_details"],
    ["The asking price is $900,000.", "unknown_amount"],
    ["You can borrow up to $600,000 with this.", "financial_advice"],
    ["Is your family situation stable?", "personal_characteristics"]
  ])("refuses %s", (text, code) => {
    expect(guardDraft(text, ctx()).violations.map(v => v.code)).toContain(code);
  });
  it("catches the floor number in any spelling, but not an allowed counter on the floor", () => {
    for (const t of ["We could do $820,000.", "maybe 820000 works", "around $820k"]) {
      expect(guardDraft(t, ctx({ floorPriceCents: 82_000_000, allowedAmountsCents: [85_000_000, 82_000_000 + 0] })).violations.map(v => v.code)).not.toContain("floor_leak");
      expect(guardDraft(t, ctx({ floorPriceCents: 82_000_000, allowedAmountsCents: [85_000_000] })).violations.map(v => v.code)).toContain("floor_leak");
    }
  });
  it("other offers may be mentioned only when the owner allows it", () => {
    expect(guardDraft("We have other offers.", ctx({ ownerAllowsOtherOffersMention: true })).ok).toBe(true);
  });
  it("reads amounts in prose", () => {
    expect(amountsInText("$850,000 or $850k or $1.2m or $650 per week or $99.50")).toEqual([85_000_000, 85_000_000, 120_000_000, 65_000, 9_950]);
  });
  it("too long and empty drafts fail", () => {
    expect(guardDraft("  ", ctx()).violations.map(v => v.code)).toContain("empty");
    expect(guardDraft("a".repeat(3000), ctx()).violations.map(v => v.code)).toContain("too_long");
  });
});
