import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  actor: null as { userId: string; userType: string } | null,
  job: null as Record<string, unknown> | null
}));
vi.mock("../src/server/context", () => ({ getActor: async () => S.actor, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/contractor-market-db", () => ({
  createPgMarketStore: () => ({ getJob: async () => S.job, listJobs: async () => (S.job ? [S.job] : []) })
}));

import * as list from "../app/api/jobs/route";
import * as one from "../app/api/jobs/[id]/route";

const ID = "55555555-5555-4555-8555-555555555555";
const ctx = { params: Promise.resolve({ id: ID }) };
const get = () => new Request("http://test/x");
const base = { id: ID, ownerUserId: "o1", contractorUserId: "c1", address: "12 Secret Lane, Paddington QLD 4064", suburb: "Paddington", status: "proposed" };

beforeEach(() => { S.actor = { userId: "c1", userType: "vendor" }; S.job = { ...base }; });

describe("job APIs hide the street address from a contractor until they accept", () => {
  it("one job and the jobs list", async () => {
    for (const r of [await one.GET(get(), ctx), await list.GET(get())]) {
      const text = JSON.stringify(await r.json());
      expect(text).not.toContain("Secret Lane");
      expect(text).toContain("Paddington");
    }
  });
  it("shows it once accepted, and always to the owner", async () => {
    S.job = { ...base, status: "approved" };
    expect(JSON.stringify(await (await one.GET(get(), ctx)).json())).toContain("Secret Lane");
    S.job = { ...base }; S.actor = { userId: "o1", userType: "owner" };
    expect(JSON.stringify(await (await one.GET(get(), ctx)).json())).toContain("Secret Lane");
    expect(JSON.stringify(await (await list.GET(get())).json())).toContain("Secret Lane");
  });
});
