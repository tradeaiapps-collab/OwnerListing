import { describe, expect, it } from "vitest";
import {
  analyseConversation, detectTone, MESSAGE_TEMPLATES, moderateMessage, needsTraining, rewriteAll, rewriteMessage, SCENARIO_LABEL, type ThreadMessage
} from "../src/domain/message-moderation";
import { scanForDiscrimination } from "../src/domain/discrimination-filter";

const cats = (t: string) => moderateMessage(t).flags.map(f => f.category);

describe("moderateMessage", () => {
  it("passes a plain professional message", () => {
    const r = moderateMessage("Hello, thanks for your offer. I can do settlement in 60 days. Kind regards");
    expect(r).toMatchObject({ risk: "none", tone: "neutral", flags: [] });
  });
  it("flags discrimination wording using the shared filter", () => {
    const text = "We would prefer no children in the property.";
    expect(scanForDiscrimination(text).flags.length).toBeGreaterThan(0);
    const r = moderateMessage(text);
    expect(cats(text)).toContain("discrimination");
    expect(r.risk).not.toBe("none");
    expect(r.flags[0]!.suggestion.length).toBeGreaterThan(0);
  });
  it.each([
    ["You must decide today or the other buyers are about to move in.", "pressure_tactics"],
    ["Hurry, this won't last and it's today only", "urgency_manipulation"],
    ["Message me on WhatsApp and we can do a cash deal", "off_platform_promise"],
    ["You should invest now, it's a guaranteed return", "financial_advice"],
    ["You don't need a solicitor, skip the inspection and waive the cooling-off", "legal_promise"]
  ])("flags %s", (text, category) => {
    expect(cats(text)).toContain(category);
    expect(moderateMessage(text).risk).not.toBe("none");
  });
  it("rates off-platform and legal promises high", () => {
    expect(moderateMessage("Let's keep this between us, text me on my mobile").risk).toBe("high");
    expect(moderateMessage("You don't need a solicitor").risk).toBe("high");
  });
  it("flags aggressive and frustrated tone without calling them compliance risks", () => {
    expect(detectTone("This offer is a joke, are you serious? What a waste of my time")).toBe("aggressive");
    expect(detectTone("WE NEED THIS NOW PLEASE REPLY")).toBe("aggressive");
    expect(detectTone("I am still waiting for a reply and I am frustrated")).toBe("frustrated");
    expect(detectTone("Thanks, that works for me.")).toBe("neutral");
    expect(moderateMessage("Are you serious? Pathetic offer.").flags.some(f => f.category === "tone" && f.severity === "medium")).toBe(true);
  });
  it("does not trip on everyday words", () => {
    expect(moderateMessage("The hurried agent left the keys. Contact me here on the platform.").risk).toBe("none");
  });
});

describe("rewriteMessage", () => {
  it("softens hostile wording in every tone and never adds numbers", () => {
    const text = "This is ridiculous, are you serious?? Your lowball of $500,000 is a waste of my time.";
    const all = rewriteAll(text);
    expect(all.map(r => r.tone)).toEqual(["professional", "friendly", "firm", "accommodating"]);
    for (const r of all) {
      expect(moderateMessage(r.text).tone).toBe("neutral");
      expect(r.text).not.toMatch(/ridiculous|waste of my time|serious\?\?/i);
      expect(r.text.match(/\$?\d[\d,]*/g)).toEqual(["$500,000"]);
    }
  });
  it("removes sentences that carry a serious concern instead of rewording them", () => {
    const r = rewriteMessage("The price is firm. Call me on WhatsApp and we can do a cash deal.", "professional")!;
    expect(r.removed).toBe(1);
    expect(r.text).toContain("The price is firm.");
    expect(r.text).not.toMatch(/whatsapp|cash deal/i);
  });
  it("returns nothing when nothing is left", () => {
    expect(rewriteMessage("You don't need a solicitor.", "friendly")).toBeUndefined();
  });
  it("calms shouting", () => {
    expect(rewriteMessage("PLEASE SEND THE REPORT NOW!!!", "professional")!.text).toMatch(/Please send the report now\./);
  });
});

describe("templates", () => {
  it("cover every required scenario, state no unfilled money figures and make no promises", () => {
    for (const s of Object.keys(SCENARIO_LABEL)) expect(MESSAGE_TEMPLATES.some(t => t.scenario === s)).toBe(true);
    for (const t of MESSAGE_TEMPLATES) {
      expect(t.body).toMatch(/\[[^\]]+\]/);
      expect(t.body).not.toMatch(/\$\d/);
      expect(moderateMessage(t.body).risk).toBe("none");
    }
  });
  it("cooling-off template defers to the contract and the solicitor", () => {
    const t = MESSAGE_TEMPLATES.find(x => x.id === "expect-cooling-off")!;
    expect(t.body).toMatch(/solicitor/);
    expect(t.body).toMatch(/trust account/);
  });
});

describe("analyseConversation", () => {
  const buyer = "b", seller = "s";
  const msg = (who: string, body: string, sentAt: string, automated = false): ThreadMessage => ({ senderUserId: who, automated, body, sentAt });
  it("detects a thread stalled for more than 3 days, either direction, and offers four follow-ups", () => {
    const a = analyseConversation([msg(seller, "Any questions?", "2026-11-01T00:00:00Z")], buyer, "2026-11-05T01:00:00Z");
    expect(a.stalled).toMatchObject({ days: 4, waitingOn: "buyer" });
    expect(a.stalled!.followUps).toHaveLength(4);
    const b = analyseConversation([msg(buyer, "Is it still available?", "2026-11-01T00:00:00Z")], buyer, "2026-11-05T01:00:00Z");
    expect(b.stalled!.waitingOn).toBe("seller");
  });
  it("is not stalled at exactly 3 days, and ignores automated notices", () => {
    expect(analyseConversation([msg(seller, "Hi", "2026-11-02T01:00:00Z")], buyer, "2026-11-05T01:00:00Z").stalled).toBeUndefined();
    const r = analyseConversation([msg(seller, "Hi", "2026-11-01T00:00:00Z"), msg("x", "auto", "2026-11-05T00:00:00Z", true)], buyer, "2026-11-05T01:00:00Z");
    expect(r.stalled?.days).toBe(4);
    expect(analyseConversation([], buyer, "2026-11-05T01:00:00Z")).toEqual({});
  });
  it("detects a tone shift after neutral messages", () => {
    const r = analyseConversation([
      msg(buyer, "Hi, interested in the house", "2026-11-04T00:00:00Z"), msg(seller, "Great", "2026-11-04T01:00:00Z"),
      msg(buyer, "Are you serious? This is a joke", "2026-11-04T02:00:00Z")
    ], buyer, "2026-11-04T03:00:00Z");
    expect(r.toneShift).toEqual({ by: "buyer", tone: "aggressive" });
    expect(r.stalled).toBeUndefined();
  });
  it("does not report a shift when the sender was already hostile", () => {
    const r = analyseConversation([msg(buyer, "this is pathetic", "2026-11-04T00:00:00Z"), msg(buyer, "pathetic again", "2026-11-04T01:00:00Z")], buyer, "2026-11-04T02:00:00Z");
    expect(r.toneShift).toBeUndefined();
  });
});

describe("training", () => {
  it("suggests training from 3 flags in 30 days", () => {
    expect(needsTraining(2)).toBe(false);
    expect(needsTraining(3)).toBe(true);
  });
});
