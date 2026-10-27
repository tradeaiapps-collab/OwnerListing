import { describe, expect, it } from "vitest";
import { createInMemoryAgentMessageRepository, readAgentConversation, sendAgentMessage } from "../src/domain/agent-messages";
import type { Actor } from "../src/domain/listing-service";

const APPT = "11111111-1111-4111-8111-111111111111";
const ENDED = "12121212-1212-4121-8121-121212121212";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "agent" };
let n = 0;
const ids = { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-25T00:00:00.000Z" };
const base = { listingId: "55555555-5555-4555-8555-555555555555", ownerUserId: owner.userId, agentUserId: agent.userId, scope: "enquiries_and_offers" as const,
  appointedAt: "2026-10-24T00:00:00.000Z", listingTitle: "House", ownerName: "Olive", agentName: "Amy" };
const repo = () => createInMemoryAgentMessageRepository([{ ...base, id: APPT }, { ...base, id: ENDED, revokedAt: "2026-10-24T12:00:00.000Z" }]);

describe("owner-agent messages", () => {
  it("owner and agent exchange messages; each sees their own marked and the other party's name", async () => {
    const r = repo();
    expect(await sendAgentMessage(r, owner, APPT, { body: "  Can you take the Saturday open home? " }, ids)).toMatchObject({ ok: true, value: { body: "Can you take the Saturday open home?" } });
    expect(await sendAgentMessage(r, agent, APPT, { body: "Yes, 10am." }, ids)).toMatchObject({ ok: true });
    const asOwner = await readAgentConversation(r, owner, APPT);
    expect(asOwner).toMatchObject({ ok: true, value: { counterpartName: "Amy", open: true, messages: [{ mine: true }, { mine: false, body: "Yes, 10am." }] } });
    const asAgent = await readAgentConversation(r, agent, APPT);
    expect(asAgent).toMatchObject({ ok: true, value: { counterpartName: "Olive", messages: [{ mine: false }, { mine: true }] } });
  });

  it("strangers and malformed ids get not_found for reading and writing", async () => {
    const r = repo();
    expect(await readAgentConversation(r, stranger, APPT)).toMatchObject({ ok: false, code: "not_found" });
    expect(await sendAgentMessage(r, stranger, APPT, { body: "hi" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await readAgentConversation(r, owner, "nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(r.messages).toEqual([]);
  });

  it("after revocation the agent loses access entirely and the owner can only read", async () => {
    const r = repo();
    expect(await readAgentConversation(r, agent, ENDED)).toMatchObject({ ok: false, code: "not_found" });
    expect(await sendAgentMessage(r, agent, ENDED, { body: "hi" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await readAgentConversation(r, owner, ENDED)).toMatchObject({ ok: true, value: { open: false } });
    expect(await sendAgentMessage(r, owner, ENDED, { body: "hi" }, ids)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("validates the body", async () => {
    const r = repo();
    for (const input of [null, {}, { body: 5 }, { body: "   " }, { body: "x".repeat(5001) }]) {
      expect(await sendAgentMessage(r, owner, APPT, input, ids)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(await sendAgentMessage(r, owner, APPT, { body: "x".repeat(5000) }, ids)).toMatchObject({ ok: true });
  });
});
