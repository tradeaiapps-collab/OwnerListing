import { describe, expect, it } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import { buildTeamComparison, type TeamCounts, type TeamFact } from "../src/domain/team-compare";

const admin: StaffActor = { id: "a", role: "super_admin" };
const reporting: StaffActor = { id: "r", role: "reporting" };
const c = (o: Partial<TeamCounts> = {}): TeamCounts => ({ enquiries: 0, offers: 0, accepted: 0, acceptedCents: 0, commissionCents: 0, ...o });
const team = (id: string, o: Partial<TeamFact> = {}): TeamFact => ({ id, name: `Team ${id}`, kind: "team", members: 3, activeListings: 2, overdueTasks: 0, current: c(), previous: c(), ...o });

describe("team comparison", () => {
  const facts = [
    team("A", { current: c({ enquiries: 20, offers: 8, accepted: 4, acceptedCents: 400_000_000, commissionCents: 8_000_000 }), previous: c({ enquiries: 10, offers: 4, accepted: 2, acceptedCents: 200_000_000 }) }),
    team("B", { current: c({ enquiries: 30, offers: 6, accepted: 5, acceptedCents: 300_000_000 }), previous: c({ enquiries: 30, offers: 6, accepted: 5 }) }),
    team("C", { current: c({ enquiries: 9, offers: 2, accepted: 2 }) })
  ];
  it("ranks teams by accepted offers once they have enough offers, and lists the rest after", () => {
    const r = buildTeamComparison(admin, facts, undefined);
    expect(r.rows.map(x => [x.name, x.rank])).toEqual([["Team B", 1], ["Team A", 2], ["Team C", undefined]]);
    expect(r.rows[1]!.sold).toEqual({ current: 4, previous: 2, changePct: 100 });
    expect(r.note).toContain("Fewer than 3 teams");
  });
  it("shows value and commission only with the financial permission, or when the caller turns money off", () => {
    expect(buildTeamComparison(admin, facts, undefined).rows[1]).toMatchObject({ soldCents: { current: 400_000_000 }, commissionCents: 8_000_000 });
    const r = buildTeamComparison(reporting, facts, undefined);
    expect(r.showMoney).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/soldCents|commissionCents/);
    expect(buildTeamComparison(admin, facts, undefined, { money: false }).showMoney).toBe(false);
  });
  it("flags quiet teams, falling sales, weak conversion and task pile-ups, but never small samples", () => {
    const r = buildTeamComparison(admin, [
      team("Q", { activeListings: 4 }),
      team("F", { current: c({ enquiries: 8, offers: 3, accepted: 1 }), previous: c({ accepted: 4 }) }),
      team("W", { current: c({ enquiries: 40, offers: 2, accepted: 1 }) }),
      team("P", { overdueTasks: 6, current: c({ enquiries: 30, offers: 15, accepted: 5 }) }),
      team("tiny", { activeListings: 1, previous: c({ accepted: 2 }), current: c({ enquiries: 2 }) })
    ], undefined);
    const ids = r.alerts.map(a => a.id);
    expect(ids).toEqual(expect.arrayContaining(["team-quiet-Q", "team-sales-F", "team-conv-W", "team-tasks-P"]));
    expect(ids.some(i => i.endsWith("tiny"))).toBe(false);
    expect(r.alerts[0]!.severity).toBe("high");
  });
  it("builds trend lines for the top teams from the buckets asked for", () => {
    const r = buildTeamComparison(admin, facts, {
      bucket: "month", buckets: ["2026-09-01", "2026-10-01"],
      rows: [{ teamId: "A", bucket: "2026-10-01", accepted: 3, cents: 3_00 }, { teamId: "A", bucket: "2026-10-01", accepted: 1, cents: 1_00 }, { teamId: "B", bucket: "2026-09-01", accepted: 5, cents: 5_00 }, { teamId: "Z", bucket: "2026-10-01", accepted: 9, cents: 9 }]
    });
    expect(r.trends!.labels).toEqual(["Sep 26", "Oct 26"]);
    expect(r.trends!.sold.map(s => [s.label, s.values, s.total])).toEqual([["Team B", [5, 0], 5], ["Team A", [0, 4], 4], ["Team C", [0, 0], 0]]);
    expect(buildTeamComparison(reporting, facts, { bucket: "month", buckets: ["2026-10-01"], rows: [] }).trends!.soldCents).toBeUndefined();
  });
});
