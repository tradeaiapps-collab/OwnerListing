import { describe, expect, it } from "vitest";
import { CHANNEL_ACCESS, CHANNELS, MAX_BODY, mayUseChannel, mentionedRoles, parseAction, parseSend, snippet, threadTitle } from "../src/domain/transaction-messages";

describe("transaction message rules", () => {
  it("finds @buyer, @seller and @agent once each, and ignores emails and look-alikes", () => {
    expect(mentionedRoles("Hi @Buyer and @agent, and @buyer again")).toEqual(["buyer", "agent"]);
    expect(mentionedRoles("mail me@seller.com or @agents or @sellers")).toEqual([]);
    expect(mentionedRoles("(@seller) please confirm")).toEqual(["seller"]);
  });

  it("trims, limits and validates a message", () => {
    expect(parseSend({ body: "  hello \r\n there " })).toEqual({ ok: true, value: { body: "hello \n there", replyToId: null } });
    expect(parseSend({ body: "   " }).ok).toBe(false);
    expect(parseSend({ body: "x".repeat(MAX_BODY + 1) }).ok).toBe(false);
    expect(parseSend({ body: 5 }).ok).toBe(false);
    expect(parseSend(null).ok).toBe(false);
    expect(parseSend({ body: "hi", replyToId: "nope" }).ok).toBe(false);
    expect(parseSend({ body: "hi", replyToId: "00000000-0000-4000-8000-000000000001" }).ok).toBe(true);
  });

  it("parses thread actions", () => {
    expect(parseAction({ action: "read" })).toEqual({ ok: true, value: { action: "read" } });
    expect(parseAction({ action: "mute", muted: true })).toMatchObject({ ok: true });
    expect(parseAction({ action: "mute" }).ok).toBe(false);
    expect(parseAction({ action: "archive", archived: "yes" }).ok).toBe(false);
    expect(parseAction({ action: "delete" }).ok).toBe(false);
    expect(parseAction({ body: "hi" })).toMatchObject({ ok: true, value: { action: "send" } });
  });

  it("titles and snippets", () => {
    expect(threadTitle("12 Reef St", "Sam")).toBe("12 Reef St - Offer from Sam");
    expect(snippet("a\n\n b   c", 90)).toBe("a b c");
    expect(snippet("x".repeat(200), 10)).toHaveLength(10);
  });

  it("gates staff channels by permission; #general is open to any staff", () => {
    expect(CHANNELS).toHaveLength(5);
    expect(mayUseChannel("general", [])).toBe(true);
    expect(mayUseChannel("disputes", ["report.sales"])).toBe(false);
    expect(mayUseChannel("disputes", ["case.manage"])).toBe(true);
    expect(mayUseChannel("finance", ["billing.manage"])).toBe(true);
    expect(CHANNEL_ACCESS.management.anyOf).toContain("staff.manage");
  });
});
