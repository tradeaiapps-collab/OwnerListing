import { describe, expect, it } from "vitest";
import { decideAutoReply } from "../src/domain/auto-reply";

const ok = { mayDraft: true, requiresHumanApproval: true, withinMandate: true, reason: "x" };
const on = { enabled: true, paused: false, reviewWindowMinutes: 30 };
const now = "2026-10-22T00:00:00.000Z";

describe("decideAutoReply", () => {
  it("holds routine replies for the owner's review window", () => {
    const r = decideAutoReply("request_information", ok, on, true, now);
    expect(r).toEqual({ kind: "send_after", sendAfter: "2026-10-22T00:30:00.000Z" });
  });
  it("never auto-sends counters or when paused, off-template, or out of mandate", () => {
    expect(decideAutoReply("recommend_counter", ok, on, true, now).kind).toBe("hold_for_owner");
    expect(decideAutoReply("draft_reply", ok, { ...on, paused: true }, true, now).kind).toBe("hold_for_owner");
    expect(decideAutoReply("draft_reply", ok, on, false, now).kind).toBe("hold_for_owner");
    expect(decideAutoReply("draft_reply", { ...ok, withinMandate: false }, on, true, now).kind).toBe("hold_for_owner");
  });
  it("requires a review window", () => {
    expect(decideAutoReply("draft_reply", ok, { ...on, reviewWindowMinutes: 0 }, true, now).kind).toBe("hold_for_owner");
  });
});
