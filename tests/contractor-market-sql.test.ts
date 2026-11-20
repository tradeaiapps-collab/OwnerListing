import { describe, expect, it, vi } from "vitest";

vi.mock("../src/server/context", () => ({ getDb: () => ({}) }));

import * as sql from "../src/server/contractor-market-db";
import { savePage, searchContractors } from "../src/server/contractor-market-db";

const statements = Object.entries(sql).filter(([k, v]) => k.endsWith("_SQL") && typeof v === "string") as [string, string][];

describe("contractor market SQL", () => {
  it("uses only $n placeholders and never interpolates input", () => {
    expect(statements.length).toBeGreaterThan(20);
    for (const [name, s] of statements) {
      expect(s, name).not.toContain("${");
      expect(s, name).not.toMatch(/\bDROP\b|\bTRUNCATE\b/i);
    }
  });
  it("deletes nothing but a contractor's own services and gallery links", () => {
    for (const [name, s] of statements) if (/\bDELETE\b/i.test(s)) expect(["CLEAR_SERVICES_SQL", "CLEAR_MEDIA_SQL"], name).toContain(name);
  });
  it("writes every job change together with its audit event, guarded by the acting party", () => {
    for (const s of [sql.PROPOSE_TIME_SQL, sql.ACCEPT_TIME_SQL, sql.REJECT_TIME_SQL, sql.MARK_DONE_SQL, sql.ADD_REVIEW_SQL]) expect(s).toContain("INSERT INTO audit_event");
    expect(sql.PROPOSE_TIME_SQL).toContain("contractor_user_id = $2::uuid");
    expect(sql.MARK_DONE_SQL).toContain("contractor_user_id = $2::uuid");
    expect(sql.ACCEPT_TIME_SQL).toContain("owner_user_id = $2::uuid");
    expect(sql.ADD_REVIEW_SQL).toContain("a.owner_user_id = $2::uuid");
    expect(sql.ADD_REVIEW_SQL).toContain("a.status = 'completed'");
    expect(sql.ADD_REVIEW_SQL).toContain("ON CONFLICT (assignment_id) DO NOTHING");
  });
  it("lists only public pages of active contractors", () => {
    for (const s of [sql.CARDS_SQL, sql.SEARCH_SQL, sql.PUBLIC_PAGE_SQL]) { expect(s).toContain("is_public"); expect(s).toContain("'suspended','closed'"); }
  });
  it("never returns an email address or a phone number in public queries", () => {
    for (const s of [sql.SEARCH_SQL, sql.PUBLIC_PAGE_SQL, sql.PUBLIC_REVIEWS_SQL, sql.PUBLIC_AREAS_SQL]) expect(s).not.toMatch(/email|phone/i);
  });
  it("escapes the name filter and passes the area as a parameter", async () => {
    const calls: unknown[][] = [];
    const db = { query: async (_t: string, p: unknown[] = []) => { calls.push(p); return { rows: [] }; } };
    await searchContractors(db, { trade: "inspector", area: " Paddington ", text: "50%_off\\" });
    expect(calls[0]).toEqual(["inspector", "Paddington", "50  off"]);
  });
  it("saves the whole page in one transaction when the pool offers one", async () => {
    const texts: string[] = [];
    const tx = { query: async (t: string) => { texts.push(t); return { rows: [{ contractor_no: 2001 }] }; } };
    let used = false;
    const db = { query: async () => ({ rows: [] }), transaction: async <T,>(fn: (q: typeof tx) => Promise<T>) => { used = true; return fn(tx); } };
    const no = await savePage(db as never, "u", { businessName: "", headline: "", about: "", tradeLabel: "", licenceNumber: "", licenceState: "", isPublic: true, services: [{ kind: "photographer", name: "P", description: "", priceCents: 100, priceType: "fixed" }], media: [] });
    expect(no).toBe(2001); expect(used).toBe(true);
    expect(texts).toEqual([sql.UPSERT_PAGE_SQL, sql.CLEAR_SERVICES_SQL, sql.INSERT_SERVICES_SQL, sql.CLEAR_MEDIA_SQL]);
  });
});
