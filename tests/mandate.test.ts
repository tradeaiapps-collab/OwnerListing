import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedFields, floorAad, parseMandateInput, toMandateView, toPolicyMandate, type MandateVersion } from "../src/domain/mandate";
import { openOfferToken, sealOfferToken } from "../src/domain/offer-link-crypto";
import { evaluateOfferAction } from "../src/domain/offers";
import { insertMandatePg, mandateHistoryPg } from "../src/server/mandate-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const good = {
  expectedVersion: 0, floorPriceCents: 150_000_000, targetPriceCents: 170_000_000, maxCounterRounds: 2, maxConcessionBpsPerRound: 150,
  approvedConditions: ["finance", "building_pest", "finance"], settlementMinDays: 30, settlementMaxDays: 60, autoModeEnabled: false,
  quietHours: { from: "20:00", to: "08:00" }
};
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("parseMandateInput", () => {
  it("accepts a full mandate and tidies the conditions", () => {
    const r = parseMandateInput(good, false);
    expect(r.ok && r.value.approvedConditions).toEqual(["building_pest", "finance"]);
    expect(r.ok && r.value.floorPriceCents).toBe(150_000_000);
  });
  it("needs a floor the first time, and lets a later save keep the old one", () => {
    const { floorPriceCents: _f, ...noFloor } = good;
    const first = parseMandateInput(noFloor, false);
    expect(!first.ok && first.fields["floorPriceCents"]).toBeTruthy();
    const later = parseMandateInput({ ...noFloor, expectedVersion: 1 }, true);
    expect(later.ok && later.value.floorPriceCents).toBeUndefined();
  });
  it("names each bad field", () => {
    const r = parseMandateInput({ ...good, floorPriceCents: 180_000_000, maxCounterRounds: 11, maxConcessionBpsPerRound: 1001, approvedConditions: ["pets"],
      settlementMinDays: 90, settlementMaxDays: 30, quietHours: { from: "8pm", to: "08:00" } }, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields).sort()).toEqual(["approvedConditions", "floorPriceCents", "maxConcessionBpsPerRound", "maxCounterRounds", "quietHours", "settlementMaxDays"]);
  });
  it("refuses auto mode until Gate G3", () => {
    const r = parseMandateInput({ ...good, autoModeEnabled: true }, false);
    expect(!r.ok && r.fields["autoModeEnabled"]).toMatch(/not available/);
  });
  it("rejects junk bodies", () => {
    expect(parseMandateInput(null, false).ok).toBe(false);
    expect(parseMandateInput({ ...good, targetPriceCents: 1.5 }, false).ok).toBe(false);
  });
});

const version = (o: Partial<MandateVersion> = {}): MandateVersion => ({
  listingId: "l1", version: 1, floorSealed: "v1.sealed", targetPriceCents: 170_000_000, maxCounterRounds: 2, maxConcessionBpsPerRound: 150,
  approvedConditions: ["finance"], settlementMinDays: 30, settlementMaxDays: 60, autoModeEnabled: false, quietHours: { from: "20:00", to: "08:00" },
  setBy: "owner", createdAt: "2026-10-25T00:00:00.000Z", ...o
});

describe("mandate views", () => {
  it("never exposes the sealed floor", () => {
    const v = toMandateView(version());
    expect(JSON.stringify(v)).not.toContain("sealed");
    expect(v.floorSet).toBe(true);
  });
  it("describes what changed between versions without showing the floor", () => {
    expect(changedFields(undefined, version())).toEqual(["Mandate created"]);
    expect(changedFields(version(), version({ version: 2, floorSealed: "v1.other", targetPriceCents: 1 }))).toEqual(["Lowest price", "Target price"]);
    expect(changedFields(version(), version({ version: 2 }))).toEqual(["No changes"]);
  });
  it("feeds the offer policy with condition labels the buyer's offer uses", () => {
    const m = toPolicyMandate(version(), 150_000_000);
    const d = evaluateOfferAction("draft_reply", { offerId: "o", listingId: "l1", priceCents: 160_000_000, counterRound: 1, conditions: ["Subject to finance"], proposedConcessionBps: 0 }, m);
    expect(d.withinMandate).toBe(true);
    const below = evaluateOfferAction("draft_reply", { offerId: "o", listingId: "l1", priceCents: 140_000_000, counterRound: 1, conditions: [], proposedConcessionBps: 0 }, m);
    expect(below.withinMandate).toBe(false);
  });
  it("seals the floor to its listing", async () => {
    const sealed = await sealOfferToken("150000000", KEY, floorAad("l1"));
    expect(await openOfferToken(sealed, KEY, floorAad("l1"))).toBe("150000000");
    expect(await openOfferToken(sealed, KEY, floorAad("l2")).catch(() => undefined)).toBeUndefined();
  });
});

describe.skipIf(!DATABASE_URL)("negotiation_mandate in Postgres", () => {
  let t: TestDb;
  let owner = "", listing = "";
  beforeAll(async () => {
    t = await createTestDb();
    owner = await addUser(t.db, "owner");
    listing = await addListing(t.db, owner);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  const row = () => {
    const { version: _v, createdAt: _c, ...rest } = version({ listingId: listing });
    return rest;
  };

  it("saves versions in order and refuses a stale save", async () => {
    expect((await insertMandatePg(t.db, row(), 0, owner, "2026-10-25T00:00:00Z"))?.version).toBe(1);
    expect((await insertMandatePg(t.db, { ...row(), maxCounterRounds: 3 }, 1, owner, "2026-10-25T01:00:00Z"))?.version).toBe(2);
    expect(await insertMandatePg(t.db, row(), 1, owner, "2026-10-25T02:00:00Z")).toBeUndefined();
    const h = await mandateHistoryPg(t.db, listing);
    expect(h.map(v => [v.version, v.maxCounterRounds])).toEqual([[2, 3], [1, 2]]);
    expect(h[0]!.approvedConditions).toEqual(["finance"]);
  });

  it("is append-only and refuses auto mode in the table too", async () => {
    await expect(t.db.query("UPDATE negotiation_mandate SET max_counter_rounds = 0 WHERE listing_id = $1", [listing])).rejects.toThrow(/append-only/);
    await expect(t.db.query("DELETE FROM negotiation_mandate WHERE listing_id = $1", [listing])).rejects.toThrow(/append-only/);
    await expect(insertMandatePg(t.db, { ...row(), autoModeEnabled: true }, 2, owner, "2026-10-25T03:00:00Z")).rejects.toThrow();
  });
});
