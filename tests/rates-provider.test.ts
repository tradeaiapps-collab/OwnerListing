import { describe, expect, it } from "vitest";
import { addressKey, parseRatesCsv } from "../src/domain/rates-provider";
import { toRatesView } from "../src/domain/listing-rates";

const HEADER = "address,state,council_amount,council_period,water_amount,water_period,water_usage_billed_separately";

describe("addressKey", () => {
  it("matches the same address written differently", () => {
    expect(addressKey("12 Smith St, Bondi NSW 2026")).toBe(addressKey("12 smith street bondi"));
    expect(addressKey("3/12 Smith Rd")).toBe("3 12 smith road");
  });
  it("keeps a street named like a state out of trouble and drops only trailing state and postcode", () => {
    expect(addressKey("5 Nt Ave Darwin NT 0800")).toBe("5 nt avenue darwin");
  });
});

describe("parseRatesCsv", () => {
  it("parses rows, spells periods, and reads the usage flag", () => {
    const r = parseRatesCsv(`${HEADER}\n12 Smith St Bondi,nsw,520.40,quarter,"1,200.00",Annual,yes\n9 Lake Rd Perth,WA,900,year,,,`);
    expect(r).toEqual({ ok: true, rows: [
      { state: "NSW", address: "12 Smith St Bondi", rates: { council: { cents: 52040, period: "quarter" }, water: { cents: 120000, period: "year" }, waterUsageBilledSeparately: true } },
      { state: "WA", address: "9 Lake Rd Perth", rates: { council: { cents: 90000, period: "year" } } }
    ] });
  });
  it("rejects the whole file with line numbers", () => {
    const r = parseRatesCsv(`${HEADER}\n12 Smith St Bondi,NSW,abc,quarter,,,\n12 smith street bondi,NSW,100,year,,,\n7 Elm St Hobart,XX,100,year,,,\n8 Elm St Hobart,TAS,,,,,`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map(e => e.line)).toEqual([2, 4, 5]);
  });
  it("needs address and state columns and known column names", () => {
    expect(parseRatesCsv("address,council_amount\nx,1").ok).toBe(false);
    expect(parseRatesCsv("address,state,colour\nx,NSW,red").ok).toBe(false);
    expect(parseRatesCsv(HEADER).ok).toBe(false);
  });
});

describe("rates view source", () => {
  it("defaults to the seller and names staff or import sources", () => {
    const base = { council: { cents: 100000, period: "year" as const }, asAt: "2026-07-01" };
    expect(toRatesView(base)).toMatchObject({ sourceKind: "owner", sourceLabel: "Stated by the seller", sourceName: null });
    expect(toRatesView({ ...base, source: { kind: "import", name: "BCC export" } })).toMatchObject({ sourceKind: "import", sourceName: "BCC export" });
  });
});
