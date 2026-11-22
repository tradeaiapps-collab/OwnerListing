import { describe, expect, it } from "vitest";
import { JURISDICTION_TIME_ZONE, deadlineInfo, isValidTimeZone, resolveTimeZone } from "../src/domain/timezone";
import { DEFAULT_LOCALE, isRtl, resolveLocale, translate } from "../src/domain/i18n";
import { applyPaymentEvent, createInvoice, gstCents } from "../src/domain/billing";
import { MAX_PAGE_SIZE, clampPageSize, decodeCursor, encodeCursor } from "../src/domain/pagination";

describe("time zones", () => {
  it("validates zones and falls back safely", () => {
    expect(isValidTimeZone("Australia/Perth")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(resolveTimeZone("Mars/Base", "Australia/Sydney")).toBe("Australia/Sydney");
    expect(JURISDICTION_TIME_ZONE.QLD).toBe("Australia/Brisbane");
  });
  it("shows a deadline in both property and viewer time", () => {
    const d = deadlineInfo("2026-10-22T02:00:00.000Z", "QLD", "Asia/Tehran");
    expect(d.propertyTime).not.toBe(d.viewerTime);
  });
});

describe("languages", () => {
  const cats = { "en-AU": { hello: "Hello", only_en: "English only" }, fa: { hello: "سلام" } };
  it("uses an enabled language, otherwise English", () => {
    expect(resolveLocale("fa", ["en-AU", "fa"])).toBe("fa");
    expect(resolveLocale("fa", ["en-AU"])).toBe(DEFAULT_LOCALE);
  });
  it("falls back to English and never returns blank", () => {
    expect(translate(cats, "fa", "hello")).toBe("سلام");
    expect(translate(cats, "fa", "only_en")).toBe("English only");
    expect(translate(cats, "fa", "missing_key")).toBe("missing_key");
    expect(isRtl("fa")).toBe(true);
    expect(isRtl("en-AU")).toBe(false);
  });
});

describe("billing", () => {
  it("adds 10% GST in whole cents", () => {
    expect(gstCents(1000)).toBe(100);
    expect(gstCents(1999)).toBe(200);
    expect(createInvoice("i1", "o1", 1000).totalCents).toBe(1100);
    expect(() => gstCents(-1)).toThrow();
  });
  it("applies a payment once and rejects a wrong amount", () => {
    const inv = createInvoice("i1", "o1", 1000);
    const ev = { eventId: "e1", invoiceId: "i1", amountCents: 1100, outcome: "succeeded" as const, providerRef: "p1" };
    const r = applyPaymentEvent(inv, ev, new Set());
    expect(r.invoice.status).toBe("paid");
    expect(applyPaymentEvent(r.invoice, ev, new Set(["e1"])).note).toMatch(/Duplicate/);
    expect(() => applyPaymentEvent(inv, { ...ev, amountCents: 1000 }, new Set())).toThrow(/amount/);
    expect(() => applyPaymentEvent(inv, { ...ev, invoiceId: "other" }, new Set())).toThrow();
  });
});

describe("pagination", () => {
  it("clamps page size and round-trips cursors", () => {
    expect(clampPageSize(10_000)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(1);
    const c = { sortValue: "2026-10-22T00:00:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("not a cursor!!")).toBeNull();
  });
});

describe("draft catalogues", () => {
  const cats = { fa: { Browse: "مرور" } };
  it("shows a catalogue only when enabled AND reviewed", async () => {
    const { catalogFor } = await import("../src/domain/i18n");
    expect(catalogFor("fa", ["fa"], [], cats)).toBeUndefined();
    expect(catalogFor("fa", [], ["fa"], cats)).toBeUndefined();
    expect(catalogFor("fa", ["fa"], ["fa"], cats)?.["Browse"]).toBe("مرور");
  });
  it("ships the Persian draft as not reviewed", async () => {
    const { REVIEWED_LOCALES, CATALOGS } = await import("../src/i18n");
    expect(REVIEWED_LOCALES).not.toContain("fa");
    expect(Object.keys(CATALOGS["fa"] ?? {}).length).toBeGreaterThan(50);
  });
});
