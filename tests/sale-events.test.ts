import { describe, expect, it } from "vitest";
import { maskName, parseManualSaleEvent } from "../src/domain/sale-events";

const NOW = "2026-11-05T00:00:00.000Z";
const ok = { eventType: "sold", amountCents: 85_000_000, occurredAt: "2025-03-14T00:00:00.000Z", source: "public_record", address: " 12 Burke St ", state: "QLD", suburb: "Paddington", postcode: "4064", propertyType: "house" };

describe("parseManualSaleEvent", () => {
  it("accepts a complete entry and trims text", () => {
    const r = parseManualSaleEvent({ ...ok, bedrooms: 3, landAreaSqm: 405.5, counterparty: "J Smith" }, NOW);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ address: "12 Burke St", bedrooms: 3, landAreaSqm: 405.5, counterparty: "J Smith", occurredAt: "2025-03-14T00:00:00.000Z" }) });
  });
  it.each([
    [{ eventType: "listed" }, /sold or rented/],
    [{ amountCents: 0 }, /above zero/],
    [{ amountCents: 1.5 }, /above zero/],
    [{ amountCents: 200_000_000_000 }, /above zero/],
    [{ eventType: "rented", amountCents: 500_000_000 }, /weekly rent/],
    [{ occurredAt: "tomorrow-ish" }, /date/],
    [{ occurredAt: "2027-01-01T00:00:00Z" }, /future/],
    [{ occurredAt: "1980-01-01T00:00:00Z" }, /too far back/],
    [{ source: "owner_supplied" }, /figure came from/],
    [{ address: "  " }, /street address/],
    [{ state: "XX" }, /state/],
    [{ postcode: "40" }, /postcode/],
    [{ propertyType: "castle" }, /property type/],
    [{ bedrooms: -1 }, /whole numbers/],
    [{ landAreaSqm: 0 }, /Land area/],
    [{ note: "x".repeat(1001) }, /too long/]
  ])("rejects %j", (patch, msg) => {
    const r = parseManualSaleEvent({ ...ok, ...patch }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
  it("rejects a non-object body", () => { expect(parseManualSaleEvent(null, NOW).ok).toBe(false); });
});

describe("maskName", () => {
  it("keeps the first letter of each word", () => {
    expect(maskName("Jane Citizen")).toBe("J*** C***");
    expect(maskName(null)).toBeNull();
  });
});
