import { describe, expect, it } from "vitest";
import { createPgDocumentStore } from "../src/server/documents-db";
import type { Queryable } from "../src/server/db";

const R = { documentId: "11111111-1111-4111-8111-111111111111", requestedBy: "22222222-2222-4222-8222-222222222222", outcome: "amend_only" as const, reason: "x" };
const L = { sinceIso: "2026-10-24T00:00:00.000Z", perWindow: 5, maxOpen: 20 };

function fakeDb(row: Record<string, unknown>, withTx: boolean) {
  const log: string[] = [];
  const q = (tag: string) => async (text: string) => {
    const lock = text.includes("advisory");
    log.push(`${tag}:${lock ? "lock" : "guard"}`);
    return { rows: lock ? [] : [row] };
  };
  const db: Queryable = { query: q("db"), ...(withTx ? { transaction: async fn => fn({ query: q("tx") }) } : {}) };
  return { db, log };
}

describe("document deletion request guard", () => {
  it("takes a per-requester advisory lock, then runs the guard, inside one transaction", async () => {
    const { db, log } = fakeDb({ inserted: "1", recent: "0", open_count: "0" }, true);
    expect(await createPgDocumentStore(db).recordDeletionRequest(R, L)).toBe("recorded");
    expect(log).toEqual(["tx:lock", "tx:guard"]);
  });
  it("maps refusals and fails closed on an unusable answer", async () => {
    const cap = fakeDb({ inserted: "0", recent: "1", open_count: "20" }, true);
    expect(await createPgDocumentStore(cap.db).recordDeletionRequest(R, L)).toBe("cap_reached");
    const rate = fakeDb({ inserted: "0", recent: "5", open_count: "1" }, true);
    expect(await createPgDocumentStore(rate.db).recordDeletionRequest(R, L)).toBe("rate_limited");
    const bad = fakeDb({}, false);
    await expect(createPgDocumentStore(bad.db).recordDeletionRequest(R, L)).rejects.toThrow();
  });
});
