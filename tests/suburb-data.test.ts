import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseImportMeta, parseSuburbCsv, splitCsvLine, suburbKey, toSuburbView, METRICS } from "../src/domain/suburb-data";
import type { StaffActor } from "../src/domain/staff-access";

const HEAD = "state,suburb,postcode,median_house_price,median_weekly_rent,population,owner_occupied_pct,median_age";

describe("parseSuburbCsv", () => {
  it("parses rows, converts dollars to cents, tolerates $ , % and quotes, and skips blank cells", () => {
    const r = parseSuburbCsv(`${HEAD}\nnsw,Bondi,2026,"$3,450,000",1100,11400,32.5,\nVIC,"St  Kilda",3182,,650,,,36`);
    expect(r).toEqual({ ok: true, rows: [
      { state: "NSW", suburb: "Bondi", postcode: "2026", metrics: { medianHousePrice: 345000000, medianWeeklyRent: 110000, population: 11400, ownerOccupiedPct: 32.5 } },
      { state: "VIC", suburb: "St Kilda", postcode: "3182", metrics: { medianWeeklyRent: 65000, medianAge: 36 } }
    ] });
  });
  it("accepts a BOM, CRLF line ends and a trailing newline, and a postcode column that is absent", () => {
    const r = parseSuburbCsv("﻿state,suburb,population\r\nQLD,Paddington,8000\r\n");
    expect(r).toEqual({ ok: true, rows: [{ state: "QLD", suburb: "Paddington", postcode: null, metrics: { population: 8000 } }] });
  });
  it.each([
    ["", "empty"],
    ["state,suburb\nNSW,Bondi", "at least one figure"],
    ["suburb,population\nBondi,1", "state column"],
    ["state,suburb,population,colour\nNSW,Bondi,1,red", "Unknown column"],
    ["state,suburb,population,population\nNSW,Bondi,1,1", "twice"],
    ["state,suburb,population", "no suburbs"],
    ['state,suburb,population\nNSW,"Bondi,1', "Unbalanced"]
  ])("rejects a bad file: %j", (csv, text) => {
    const r = parseSuburbCsv(csv);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(text);
  });
  it("lists every bad line, rejects the whole file, and caps the list at 20", () => {
    const r = parseSuburbCsv(`${HEAD}\nXX,A,2000,1,1,1,1,1\nNSW,B,20x0,1,1,1,1,1\nNSW,C,2000,abc,1,1,1,1\nNSW,D,2000,1,1,1,101,1\nNSW,E,2000,1,1,1.5,1,1\nNSW,F,2000,,,,,\nNSW,G,2000,1,1,1\nNSW,Bondi,2026,1,1,1,1,1\nNSW,bondi,2026,1,1,1,1,1`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map(e => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 10]);
    expect(r.errors[0]!.message).toContain("State must be");
    expect(r.errors[7]!.message).toContain("more than once");
    const many = parseSuburbCsv(`state,suburb,population\n${Array.from({ length: 30 }, () => "XX,A,1").join("\n")}`);
    expect(many.ok ? 0 : many.errors.length).toBe(20);
  });
  it("enforces the row limit and a zero price", () => {
    const big = `state,suburb,population\n${Array.from({ length: 2001 }, (_, i) => `NSW,S${i},1`).join("\n")}`;
    expect(parseSuburbCsv(big)).toMatchObject({ ok: false });
    expect(parseSuburbCsv("state,suburb,median_house_price\nNSW,A,0")).toMatchObject({ ok: false });
  });
  it("every metric column round-trips to a unique key", () => {
    expect(new Set(METRICS.map(m => m.key)).size).toBe(METRICS.length);
    expect(new Set(METRICS.map(m => m.column)).size).toBe(METRICS.length);
  });
});

describe("helpers", () => {
  it("splits quoted CSV lines", () => {
    expect(splitCsvLine('a,"b,c","d""e", f ')).toEqual(["a", "b,c", 'd"e', "f"]);
    expect(splitCsvLine('a,"b')).toBeNull();
    expect(splitCsvLine('a,b"c')).toBeNull();
  });
  it("normalises suburb keys", () => { expect(suburbKey("  St   KILDA ")).toBe("st kilda"); });
  it("validates the source and date", () => {
    expect(parseImportMeta(" ABS Census 2021 ", "2021-08-10", "2026-11-18")).toEqual({ ok: true, source: "ABS Census 2021", asAt: "2021-08-10" });
    for (const [s, d] of [["x", "2026-01-01"], ["ABS", "2026-02-30"], ["ABS", "2026-11-19"], ["ABS", "2016-11-17"], [5, "2026-01-01"], ["ABS", undefined]] as const) {
      expect(parseImportMeta(s, d, "2026-11-18").ok).toBe(false);
    }
  });
  it("formats the buyer view in a fixed order, only for figures present", () => {
    const v = toSuburbView({ suburb: "Bondi", state: "NSW", postcode: "2026", source: "ABS", asAt: "2021-08-10", metrics: { population: 11400, medianHousePrice: 345000000, medianWeeklyRent: 110000, ownerOccupiedPct: 32.5, rentalVacancyPct: 2, medianAge: 36 } })!;
    expect(v.facts).toEqual([
      { label: "Median house price", value: "$3,450,000" }, { label: "Median weekly rent", value: "$1,100 per week" }, { label: "Population", value: "11,400" },
      { label: "Median age", value: "36 years" }, { label: "Homes lived in by their owner", value: "32.5%" }, { label: "Rental vacancy rate", value: "2%" }
    ]);
    expect(toSuburbView({ suburb: "X", state: "NSW", postcode: null, source: "ABS", asAt: "2021-08-10", metrics: {} })).toBeNull();
  });
});

const st = vi.hoisted(() => ({ staff: null as StaffActor | null, imported: [] as unknown[], audits: [] as string[], profile: null as unknown }));
vi.mock("../src/server/context", () => ({ getStaff: async () => st.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string }) => { st.audits.push(e.eventType); } }));
vi.mock("../src/server/suburb-data-db", () => ({
  importSuburbsPg: async (_d: unknown, rows: unknown[], meta: unknown) => { st.imported.push([rows, meta]); return { created: rows.length - 1, updated: 1 }; },
  listSuburbsPg: async () => ({ rows: [], total: 0 }),
  getSuburbPg: async () => st.profile
}));
import * as staffRoute from "../app/api/staff/suburb-data/route";
import * as publicRoute from "../app/api/suburbs/profile/route";
process.env["APP_URL"] = "http://test";

const admin: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
const support: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "support" };
const post = (b: unknown) => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(b) });
const GOOD = { source: "ABS Census 2021", asAt: "2021-08-10", csv: "state,suburb,population\nNSW,Bondi,11400\nNSW,Manly,16000" };

beforeEach(() => { st.staff = admin; st.imported = []; st.audits = []; st.profile = null; });

describe("staff import route", () => {
  it("imports a good file, reports counts and audits without figures", async () => {
    const res = await staffRoute.POST(post(GOOD));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ imported: 2, created: 1, updated: 1 });
    expect(st.audits).toEqual(["suburb_data.imported"]);
    expect((st.imported[0] as [unknown[], { source: string }])[1].source).toBe("ABS Census 2021");
  });
  it("rejects a bad file with line errors and saves nothing", async () => {
    const res = await staffRoute.POST(post({ ...GOOD, csv: "state,suburb,population\nXX,Bondi,1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).lines[0].line).toBe(2);
    expect(st.imported).toEqual([]);
  });
  it("needs a source and a date, and a csv string", async () => {
    expect((await staffRoute.POST(post({ ...GOOD, source: "" }))).status).toBe(400);
    expect((await staffRoute.POST(post({ source: "ABS", asAt: "2021-08-10" }))).status).toBe(400);
  });
  it("401 signed out, 403 without feeds.manage, 403 cross-site", async () => {
    st.staff = null;
    expect((await staffRoute.POST(post(GOOD))).status).toBe(401);
    expect((await staffRoute.GET(new Request("http://test/x"))).status).toBe(401);
    st.staff = support;
    expect((await staffRoute.POST(post(GOOD))).status).toBe(403);
    expect((await staffRoute.GET(new Request("http://test/x"))).status).toBe(403);
    st.staff = admin;
    const evil = new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify(GOOD) });
    expect((await staffRoute.POST(evil)).status).toBe(403);
    expect(st.imported).toEqual([]);
  });
  it("lists for staff", async () => {
    const res = await staffRoute.GET(new Request("http://test/x?q=bon"));
    expect(res.status).toBe(200);
    expect((await res.json()).columns).toContain("median_house_price");
  });
});

describe("public profile route", () => {
  const get = (q: string) => publicRoute.GET(new Request(`http://test/api/suburbs/profile?${q}`));
  it("400s a bad state or missing suburb", async () => {
    expect((await get("state=XX&suburb=Bondi")).status).toBe(400);
    expect((await get("state=NSW")).status).toBe(400);
  });
  it("returns null when the suburb is not loaded and the view when it is", async () => {
    expect(await (await get("state=nsw&suburb=Bondi")).json()).toEqual({ view: null });
    st.profile = { suburb: "Bondi", state: "NSW", postcode: "2026", metrics: { population: 11400 }, source: "ABS Census 2021", asAt: "2021-08-10" };
    const res = await get("state=NSW&suburb=Bondi");
    expect((await res.json()).view.facts).toEqual([{ label: "Population", value: "11,400" }]);
    expect(res.headers.get("cache-control")).toContain("public");
  });
});
