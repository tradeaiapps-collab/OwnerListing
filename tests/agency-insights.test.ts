import { describe, expect, it } from "vitest";
import { buildInsights, elenaSummary, type DashboardRow } from "../src/domain/agency-insights";
import { splitCommission } from "../src/domain/agency-team";

const NOW = "2026-11-05T00:00:00.000Z";
const row = (o: Partial<DashboardRow> & { userId: string }): DashboardRow => ({
  displayName: o.userId, role: "agent", activeListings: 0, openTasks: 0, overdueTasks: 0, doneLast30: 0,
  owedCents: 0, paidCents: 0, recordedCents: 0, oldestUnpaidAt: null, ...o
});

describe("splitCommission", () => {
  it("rounds the member's share down so member + office always equals gross", () => {
    expect(splitCommission(1_000_000, 7000)).toEqual({ memberCents: 700_000, officeCents: 300_000 });
    expect(splitCommission(101, 5000)).toEqual({ memberCents: 50, officeCents: 51 });
    expect(splitCommission(1, 9999)).toEqual({ memberCents: 0, officeCents: 1 });
    expect(splitCommission(99_999_999_999, 10000)).toEqual({ memberCents: 99_999_999_999, officeCents: 0 });
    for (const [g, b] of [[12345, 3333], [7, 6666], [100_000_000_000, 1]] as const) {
      const s = splitCommission(g, b);
      expect(s.memberCents + s.officeCents).toBe(g);
    }
  });
});

describe("Elena's team insights", () => {
  it("says nothing is wrong for a healthy team", () => {
    const rows = [row({ userId: "m", role: "manager", activeListings: 2, doneLast30: 3 }), row({ userId: "a", activeListings: 2, doneLast30: 2 })];
    expect(buildInsights(rows, NOW)).toEqual([]);
    expect(elenaSummary([], "North office")).toContain("looks healthy");
  });

  it("flags overdue work, stalled work and stale payouts, most urgent first", () => {
    const rows = [
      row({ userId: "m", role: "manager" }), row({ userId: "m2", role: "manager" }),
      row({ userId: "late", openTasks: 5, overdueTasks: 3 }),
      row({ userId: "stuck", openTasks: 3, overdueTasks: 1 }),
      row({ userId: "owed", owedCents: 50_000, oldestUnpaidAt: "2026-09-20T00:00:00.000Z" }),
      row({ userId: "fresh", owedCents: 50_000, oldestUnpaidAt: "2026-11-01T00:00:00.000Z" })
    ];
    const out = buildInsights(rows, NOW);
    expect(out.map(i => [i.kind, i.memberUserId])).toEqual([
      ["overdue_tasks", "late"], ["stale_payout", "owed"], ["stalled_tasks", "stuck"]
    ]);
    expect(out[0]!.severity).toBe("high");
    expect(elenaSummary(out, "North office")).toMatch(/^I found 3 things worth a look in North office\. The most important: late has 3 overdue tasks/);
  });

  it("flags a listing imbalance and idle capacity, and a lone manager on a larger team", () => {
    const rows = [
      row({ userId: "m", role: "manager" }), row({ userId: "busy", activeListings: 10 }),
      row({ userId: "ok", activeListings: 2 }), row({ userId: "idle", activeListings: 0 }), row({ userId: "desk", role: "staff" })
    ];
    const kinds = buildInsights(rows, NOW).map(i => `${i.kind}:${i.memberUserId ?? ""}`);
    expect(kinds).toContain("listing_imbalance:busy");
    expect(kinds).toContain("spare_capacity:idle");
    expect(kinds).toContain("single_manager:");
    expect(kinds.some(k => k.endsWith(":desk"))).toBe(false);
  });
});
