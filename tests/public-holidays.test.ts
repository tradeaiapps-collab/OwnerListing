import { describe, expect, it } from "vitest";
import { easterSunday, isIsoDate, parseGenerateInput, parseHolidayInput, standardHolidays } from "../src/domain/public-holidays";
import { businessDaysAfter, holidaysSkipped, proposeOutcome, type OutcomeInput } from "../src/domain/sale-fall-through";

const dates = (state: Parameters<typeof standardHolidays>[0], year: number) => standardHolidays(state, year).map(h => h.date);
const named = (state: Parameters<typeof standardHolidays>[0], year: number, name: string) => standardHolidays(state, year).find(h => h.name === name)?.date;

describe("easter and moveable holidays", () => {
  it("finds Easter Sunday for known years", () => {
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    expect(iso(easterSunday(2025))).toBe("2025-04-20");
    expect(iso(easterSunday(2026))).toBe("2026-04-05");
    expect(iso(easterSunday(2027))).toBe("2027-03-28");
  });
  it("puts Good Friday and Easter Monday around it in every state", () => {
    for (const s of ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const) {
      expect(named(s, 2026, "Good Friday")).toBe("2026-04-03");
      expect(named(s, 2026, "Easter Monday")).toBe("2026-04-06");
    }
  });
});

describe("state-specific holidays", () => {
  it("uses each state's own Labour Day and King's Birthday", () => {
    expect(named("NSW", 2026, "Labour Day")).toBe("2026-10-05");
    expect(named("VIC", 2026, "Labour Day")).toBe("2026-03-09");
    expect(named("QLD", 2026, "Labour Day")).toBe("2026-05-04");
    expect(named("WA", 2026, "Labour Day")).toBe("2026-03-02");
    expect(named("NSW", 2026, "King's Birthday")).toBe("2026-06-08");
    expect(named("QLD", 2026, "King's Birthday")).toBe("2026-10-05");
    expect(named("WA", 2026, "King's Birthday")).toBeUndefined(); // announced each year: staff add it
  });
  it("adds territory days and keeps them out of other states", () => {
    expect(named("ACT", 2026, "Canberra Day")).toBe("2026-03-09");
    expect(named("ACT", 2026, "Reconciliation Day")).toBe("2026-06-01");
    expect(named("NT", 2026, "Picnic Day")).toBe("2026-08-03");
    expect(named("NSW", 2026, "Canberra Day")).toBeUndefined();
  });
});

describe("holidays that fall on a weekend", () => {
  it("moves a weekend Australia Day to Monday (26 Jan 2025 was a Sunday) and drops days that stay on a weekend", () => {
    expect(named("NSW", 2025, "Australia Day")).toBe("2025-01-27");
    expect(dates("NSW", 2026)).not.toContain("2026-12-26"); // Boxing Day is a Saturday: it moves to Monday 28
    expect(named("NSW", 2026, "Boxing Day")).toBe("2026-12-28");
  });
  it("moves Christmas and Boxing Day when they fall on Saturday and Sunday (2027)", () => {
    expect(named("NSW", 2027, "Christmas Day")).toBe("2027-12-27");
    expect(named("NSW", 2027, "Boxing Day")).toBe("2027-12-28");
  });
  it("moves Anzac Day only in WA and NT when it is a Sunday (2027)", () => {
    expect(named("WA", 2027, "Anzac Day")).toBe("2027-04-26");
    expect(named("NSW", 2027, "Anzac Day")).toBeUndefined(); // a Sunday, and NSW does not move it
  });
  it("never lists a Saturday or Sunday", () => {
    for (const s of ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const) for (const y of [2025, 2026, 2027, 2028])
      for (const d of dates(s, y)) expect([0, 6]).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
  });
});

describe("business days with holidays", () => {
  it("leaves holidays out of the count", () => {
    // Wed 1 Apr 2026 to Tue 14 Apr: 9 weekdays, less Good Friday and Easter Monday.
    expect(businessDaysAfter("2026-04-01", "2026-04-14")).toBe(9);
    expect(businessDaysAfter("2026-04-01", "2026-04-14", ["2026-04-03", "2026-04-06"])).toBe(7);
    expect(holidaysSkipped("2026-04-01", "2026-04-14", ["2026-04-03", "2026-04-06"])).toBe(2);
  });
  it("ignores a holiday on a weekend, on the contract day, or outside the range", () => {
    expect(businessDaysAfter("2026-11-02", "2026-11-06", ["2026-11-07", "2026-11-02", "2026-12-25"])).toBe(4); // Mon contract day is never counted
    expect(businessDaysAfter("2026-11-02", "2026-11-06", ["2026-11-07", "2026-11-02"])).toBe(4);
  });
  it("counts a long weekend as no extra days (Fri holiday, Mon holiday, weekend between)", () => {
    expect(businessDaysAfter("2026-04-02", "2026-04-07", ["2026-04-03", "2026-04-06"])).toBe(1); // only Tue 7 Apr
  });
  it("lists the same holiday twice without double-removing it", () => {
    expect(businessDaysAfter("2026-04-01", "2026-04-07", ["2026-04-03", "2026-04-03"])).toBe(3);
  });
});

describe("cooling-off with public holidays", () => {
  const base: OutcomeInput = { reason: "cooling_off", party: "buyer", state: "NSW", priceCents: 80_000_000, heldCents: 4_000_000, acceptedOn: "2026-04-01", raisedOn: "2026-04-09" };
  const EASTER = ["2026-04-03", "2026-04-06"];
  it("is outside the 5 business days without holidays but inside once Easter is excluded", () => {
    expect(proposeOutcome(base)).toMatchObject({ ok: false });
    const r = proposeOutcome({ ...base, holidays: EASTER });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.value.basis).toContain("used 4 (2 public holidays not counted)");
  });
  it("still ends once the extended period has passed", () => {
    expect(proposeOutcome({ ...base, raisedOn: "2026-04-10", holidays: EASTER })).toMatchObject({ ok: true }); // 5th business day
    expect(proposeOutcome({ ...base, raisedOn: "2026-04-13", holidays: EASTER })).toMatchObject({ ok: false }); // 6th
  });
  it("is unchanged when there are no holidays, and says nothing about them", () => {
    const r = proposeOutcome({ ...base, acceptedOn: "2026-11-02", raisedOn: "2026-11-04" });
    if (r.ok) expect(r.value.basis).not.toContain("public holiday");
  });
});

describe("holiday input", () => {
  it("accepts a valid holiday and normalises state and name", () => {
    expect(parseHolidayInput({ state: "vic", date: "2026-11-03", name: "  Melbourne Cup  " })).toEqual({ ok: true, value: { state: "VIC", date: "2026-11-03", name: "Melbourne Cup" } });
  });
  it("rejects a bad state, a date that is not real, a far-off year and a bad name", () => {
    expect(parseHolidayInput(null)).toMatchObject({ ok: false });
    expect(parseHolidayInput({ state: "XX", date: "2026-11-03", name: "Cup" })).toMatchObject({ ok: false });
    expect(parseHolidayInput({ state: "VIC", date: "2026-02-30", name: "Cup" })).toMatchObject({ ok: false });
    expect(parseHolidayInput({ state: "VIC", date: "3026-02-01", name: "Cup" })).toMatchObject({ ok: false });
    expect(parseHolidayInput({ state: "VIC", date: "2026-11-03", name: "x" })).toMatchObject({ ok: false });
    expect(isIsoDate("2026-13-01")).toBe(false);
  });
  it("parses the fill-in request", () => {
    expect(parseGenerateInput({ state: "ALL", year: 2027 })).toMatchObject({ ok: true, value: { year: 2027 } });
    expect(parseGenerateInput({ state: "qld", year: 2027 })).toEqual({ ok: true, value: { states: ["QLD"], year: 2027 } });
    expect(parseGenerateInput({ state: "QLD", year: "2027" })).toMatchObject({ ok: false });
    expect(parseGenerateInput({ state: "QLD", year: 1999 })).toMatchObject({ ok: false });
  });
});
