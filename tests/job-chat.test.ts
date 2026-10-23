import { describe, expect, it } from "vitest";
import { appendChatMessage, canReadChat, type JobAssignment, type ChatMessage } from "../src/domain/job-chat";

const a: JobAssignment = { id: "a1", listingId: "l1", ownerUserId: "o1", contractorUserId: "c1", kind: "photographer", status: "approved" };
const m = (id: string, senderId = "o1"): ChatMessage => ({ id, assignmentId: "a1", senderId, body: "hi", sentAt: "2026-10-22T00:00:00.000Z", attachmentRefs: [] });

describe("job chat", () => {
  it("lets only the two parties post, and only while approved", () => {
    expect(appendChatMessage(a, [], m("1"))).toHaveLength(1);
    expect(() => appendChatMessage(a, [], m("2", "x"))).toThrow(/Only the owner/);
    expect(() => appendChatMessage({ ...a, status: "proposed" }, [], m("3"))).toThrow(/approved/);
    expect(() => appendChatMessage({ ...a, status: "completed" }, [], m("4"))).toThrow(/approved/);
  });
  it("rejects duplicates and never changes the original list", () => {
    const first = appendChatMessage(a, [], m("1"));
    expect(() => appendChatMessage(a, first, m("1"))).toThrow(/Duplicate/);
    expect(first).toHaveLength(1);
  });
  it("lets only participants read, and not before approval", () => {
    expect(canReadChat(a, "c1")).toBe(true);
    expect(canReadChat(a, "x")).toBe(false);
    expect(canReadChat({ ...a, status: "proposed" }, "o1")).toBe(false);
  });
});
