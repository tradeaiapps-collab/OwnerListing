import { describe, expect, it } from "vitest";
import {
  createDraft, createInMemoryListingRepository, publishListing,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import { verifiedLicencesPg, type Queryable } from "../src/server/db";

const fakeDb = (rows: Record<string, unknown>[]) => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Queryable = {
    async query(text, params) {
      calls.push(params ? { text, params } : { text });
      return { rows };
    }
  };
  return { db, calls };
};

describe("verifiedLicencesPg", () => {
  it("asks only for verified rows with a constant, parameter-free query", async () => {
    const { db, calls } = fakeDb([]);
    await verifiedLicencesPg(db);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("FROM agent_licence WHERE status = 'verified'");
    expect(calls[0]!.params).toBeUndefined();
  });

  it("maps rows: trims CHAR(3) padding, keeps date strings, omits missing expiry", async () => {
    const { db } = fakeDb([
      { user_id: "u1", jurisdiction: "NT ", status: "verified", expires_at: "2027-01-31" },
      { user_id: "u2", jurisdiction: "QLD", status: "verified", expires_at: null }
    ]);
    expect(await verifiedLicencesPg(db)).toEqual([
      { userId: "u1", jurisdiction: "NT", status: "verified", expiresAt: "2027-01-31" },
      { userId: "u2", jurisdiction: "QLD", status: "verified" }
    ]);
  });

  it("drops rows with an unknown jurisdiction", async () => {
    const { db } = fakeDb([{ user_id: "u1", jurisdiction: "XXX", status: "verified", expires_at: null }]);
    expect(await verifiedLicencesPg(db)).toEqual([]);
  });
});

describe("publish gate with licence records", () => {
  const agent: Actor = { userId: "agent-1", userType: "agent" };
  const input: DraftInput = {
    title: "Agent listing", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
    transactionType: "sale", useClass: "residential", propertyType: "house"
  };
  const LICENCE_REASON = "Agent licence must be verified before publication.";

  /** rows === null means no licence source is wired at all. */
  const run = async (rows: Record<string, unknown>[] | null) => {
    let n = 0;
    const { db } = fakeDb(rows ?? []);
    const deps: ListingServiceDeps = {
      repo: createInMemoryListingRepository(),
      appendAudit: async () => {},
      now: () => "2026-10-24T00:00:00.000Z",
      newId: () => `id-${++n}`,
      requiredDisclosures: () => [],
      ...(rows === null ? {} : { licences: () => verifiedLicencesPg(db) })
    };
    const draft = await createDraft(deps, agent, input);
    const r = await publishListing(deps, agent, draft.id, true);
    if (!r.ok) throw new Error("expected ok");
    return r.value.decision.reasons;
  };

  it("blocks an agent when no licence source is wired", async () => {
    expect(await run(null)).toContain(LICENCE_REASON);
  });
  it("blocks an agent with no verified licence record", async () => {
    expect(await run([])).toContain(LICENCE_REASON);
  });
  it("blocks a verified licence for another state", async () => {
    expect(await run([{ user_id: "agent-1", jurisdiction: "NSW", status: "verified", expires_at: null }])).toContain(LICENCE_REASON);
  });
  it("blocks an expired licence", async () => {
    expect(await run([{ user_id: "agent-1", jurisdiction: "QLD", status: "verified", expires_at: "2026-10-23" }])).toContain(LICENCE_REASON);
  });
  it("clears the licence reason for a verified, unexpired licence in the listing's state", async () => {
    expect(await run([{ user_id: "agent-1", jurisdiction: "QLD", status: "verified", expires_at: "2027-01-01" }])).not.toContain(LICENCE_REASON);
  });
});
