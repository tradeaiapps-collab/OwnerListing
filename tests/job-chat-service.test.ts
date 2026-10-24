import { beforeEach, describe, expect, it } from "vitest";
import type { JobAssignment } from "../src/domain/job-chat";
import { createInMemoryChatRepository, postChatMessage, readChat } from "../src/domain/job-chat-service";
import * as service from "../src/domain/job-chat-service";
import { ASSIGNMENT_SQL, INSERT_MESSAGE_SQL, LIST_MESSAGES_SQL, createPgChatRepository } from "../src/server/job-chat-db";
import type { Actor } from "../src/domain/listing-service";

const A = "11111111-1111-4111-8111-111111111111";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const contractor: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };

const assignment = (status: JobAssignment["status"]): JobAssignment => ({
  id: A, listingId: "55555555-5555-4555-8555-555555555555",
  ownerUserId: owner.userId, contractorUserId: contractor.userId, kind: "photographer", status
});

let n: number;
const ids = { newId: () => `66666666-6666-4666-8666-${String(++n).padStart(12, "0")}`, now: () => "2026-10-24T00:00:00.000Z" };
beforeEach(() => { n = 0; });

describe("readChat", () => {
  it("lets both parties read an approved chat", async () => {
    const repo = createInMemoryChatRepository([assignment("approved")]);
    await postChatMessage(repo, owner, A, { body: "Hello" }, ids);
    for (const who of [owner, contractor]) {
      const r = await readChat(repo, who, A);
      expect(r.ok && r.value.map(m => m.body)).toEqual(["Hello"]);
    }
  });
  it("returns not_found for non-parties, unapproved chats, unknown and malformed ids", async () => {
    const repo = createInMemoryChatRepository([assignment("approved"), { ...assignment("proposed"), id: "77777777-7777-4777-8777-777777777777" }]);
    expect(await readChat(repo, stranger, A)).toMatchObject({ ok: false, code: "not_found" });
    expect(await readChat(repo, owner, "77777777-7777-4777-8777-777777777777")).toMatchObject({ ok: false, code: "not_found" });
    expect(await readChat(repo, owner, "88888888-8888-4888-8888-888888888888")).toMatchObject({ ok: false, code: "not_found" });
    expect(await readChat(repo, owner, "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("keeps a finished chat readable", async () => {
    const repo = createInMemoryChatRepository([assignment("completed")]);
    expect((await readChat(repo, contractor, A)).ok).toBe(true);
  });
});

describe("postChatMessage", () => {
  it("stores a trimmed message from either party", async () => {
    const repo = createInMemoryChatRepository([assignment("approved")]);
    const r = await postChatMessage(repo, contractor, A, { body: "  Photos ready  " }, ids);
    expect(r.ok && r.value).toMatchObject({ body: "Photos ready", senderId: contractor.userId, assignmentId: A, attachmentRefs: [] });
    expect(repo.messages).toHaveLength(1);
  });
  it("returns not_found to a non-party and stores nothing", async () => {
    const repo = createInMemoryChatRepository([assignment("approved")]);
    expect(await postChatMessage(repo, stranger, A, { body: "hi" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(repo.messages).toHaveLength(0);
  });
  it("returns conflict once the job is completed or cancelled, and not_found before approval", async () => {
    for (const status of ["completed", "cancelled"] as const) {
      const repo = createInMemoryChatRepository([assignment(status)]);
      expect(await postChatMessage(repo, owner, A, { body: "late" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    }
    const proposed = createInMemoryChatRepository([assignment("proposed")]);
    expect(await postChatMessage(proposed, owner, A, { body: "early" }, ids)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("rejects bad bodies and attachments", async () => {
    const repo = createInMemoryChatRepository([assignment("approved")]);
    for (const input of [null, "x", {}, { body: 5 }, { body: "   " }, { body: "x".repeat(5001) }, { body: "ok", attachmentRefs: ["file-1"] }]) {
      expect(await postChatMessage(repo, owner, A, input, ids)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(repo.messages).toHaveLength(0);
  });
});

describe("permanent record", () => {
  it("exposes no edit or delete function", () => {
    expect(Object.keys(service).filter(k => /update|edit|delete|remove/i.test(k))).toEqual([]);
  });
  it("uses no UPDATE or DELETE statement, and only bound parameters", () => {
    for (const sql of [ASSIGNMENT_SQL, LIST_MESSAGES_SQL, INSERT_MESSAGE_SQL]) {
      expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/i);
      expect(sql).not.toMatch(/\$\{|'\s*\+/);
    }
  });
});

describe("createPgChatRepository", () => {
  it("passes user input only as parameters and maps rows", async () => {
    const calls: { text: string; params?: unknown[] }[] = [];
    const db = {
      async query(text: string, params?: unknown[]) {
        calls.push(params === undefined ? { text } : { text, params });
        if (text === ASSIGNMENT_SQL) return { rows: [{ id: A, listing_id: "l", owner_user_id: "o", contractor_user_id: "c", kind: "solicitor", status: "approved" }] };
        if (text === LIST_MESSAGES_SQL) return { rows: [{ id: "m", assignment_id: A, sender_id: "o", body: "Hi", sent_at: new Date("2026-10-24T00:00:00Z"), attachment_refs: [] }] };
        return { rows: [{ id: "m" }] };
      }
    };
    const repo = createPgChatRepository(db);
    expect(await repo.getAssignment(A)).toEqual({ id: A, listingId: "l", ownerUserId: "o", contractorUserId: "c", kind: "solicitor", status: "approved" });
    expect(await repo.listMessages(A, 200)).toEqual([{ id: "m", assignmentId: A, senderId: "o", body: "Hi", sentAt: "2026-10-24T00:00:00.000Z", attachmentRefs: [] }]);
    const evil = "x'); DROP TABLE chat_message; --";
    expect(await repo.insertMessage({ id: "m", assignmentId: A, senderId: "o", body: evil, sentAt: "t", attachmentRefs: [] })).toBe(true);
    expect(calls[2]?.text).toBe(INSERT_MESSAGE_SQL);
    expect(calls[2]?.params).toEqual(["m", A, "o", evil, "t"]);
    expect(INSERT_MESSAGE_SQL).not.toContain("DROP");
  });
  it("reports a refused insert as false", async () => {
    const repo = createPgChatRepository({ async query() { return { rows: [] }; } });
    expect(await repo.insertMessage({ id: "m", assignmentId: A, senderId: "o", body: "x", sentAt: "t", attachmentRefs: [] })).toBe(false);
  });
});
