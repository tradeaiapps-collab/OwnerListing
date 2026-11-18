import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseItems, requiredKeys } from "../src/domain/disclosure-config";
import { STATE_MORE_DRAFT_VERSIONS, STATE_MORE_SEED_NOTE } from "../src/config/disclosures-states-more";
import { STATE_DRAFT_VERSIONS } from "../src/config/disclosures-states";

const STATES = ["ACT", "NSW", "NT", "SA", "TAS", "VIC", "WA"];

describe("non-QLD rent and commercial seed", () => {
  it("covers every state for commercial sale, residential rent and commercial rent, with no overlap with the residential sale seed", () => {
    for (const [tx, use] of [["sale", "commercial"], ["rent", "residential"], ["rent", "commercial"]] as const) {
      const states = STATE_MORE_DRAFT_VERSIONS.filter(v => v.transactionType === tx && v.useClass === use).map(v => v.jurisdiction).sort();
      expect(states).toEqual(STATES);
    }
    expect(STATE_MORE_DRAFT_VERSIONS).toHaveLength(21);
    const combos = [...STATE_DRAFT_VERSIONS, ...STATE_MORE_DRAFT_VERSIONS].map(v => `${v.jurisdiction}:${v.transactionType}:${v.useClass}`);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("has valid items, unique stable keys, and at least one requirement for each property type it applies to", () => {
    const keys = new Set<string>();
    for (const v of STATE_MORE_DRAFT_VERSIONS) {
      expect(parseItems(v.items)).toEqual({ ok: true, value: v.items });
      const types = v.useClass === "commercial" ? ["office", "retail"] : ["house", "unit"];
      for (const t of types) expect(requiredKeys(v.items, t as never).length).toBeGreaterThanOrEqual(0);
      for (const i of v.items) {
        expect(i.key.startsWith(`${v.jurisdiction.toLowerCase()}_`)).toBe(true);
        expect(keys.has(i.key)).toBe(false);
        keys.add(i.key);
      }
    }
  });

  it("residential rent requires an agreement, condition report, bond and smoke alarms with no opt-out", () => {
    for (const v of STATE_MORE_DRAFT_VERSIONS.filter(x => x.transactionType === "rent" && x.useClass === "residential")) {
      expect(v.items.map(i => i.key.replace(/^[a-z]+_rent_/, "")).sort()).toEqual(["agreement", "bond", "condition_report", "smoke_alarms"]);
      expect(v.items.every(i => !i.notApplicableAllowed)).toBe(true);
    }
  });

  it("retail lease disclosure only applies to retail and can be marked not applicable", () => {
    for (const v of STATE_MORE_DRAFT_VERSIONS.filter(x => x.transactionType === "rent" && x.useClass === "commercial")) {
      expect(requiredKeys(v.items, "office")).toEqual([]);
      expect(requiredKeys(v.items, "retail")).toHaveLength(1);
      expect(v.items[0]!.notApplicableAllowed).toBe(true);
    }
  });

  it("matches its migration exactly, and the migration seeds drafts only", () => {
    const sql = readFileSync("db/20261118090000_state_rent_commercial_disclosure_drafts.sql", "utf8");
    const rows = [...sql.matchAll(/\('(\w+)', '(\w+)', '(\w+)', 1, '((?:[^']|'')*)'::jsonb, '(\w+)', '((?:[^']|'')*)'\)/g)];
    expect(rows).toHaveLength(STATE_MORE_DRAFT_VERSIONS.length);
    for (const [, j, tx, use, json, status, note] of rows) {
      const v = STATE_MORE_DRAFT_VERSIONS.find(x => x.jurisdiction === j && x.transactionType === tx && x.useClass === use)!;
      expect(v).toBeDefined();
      expect(JSON.parse(json!.replace(/''/g, "'"))).toEqual(JSON.parse(JSON.stringify(v.items)));
      expect(status).toBe("draft");
      expect(note!.replace(/''/g, "'")).toBe(STATE_MORE_SEED_NOTE);
    }
  });
});
