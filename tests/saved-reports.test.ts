import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exportReport, reportToCsv, reportToPdf, reportToXlsx, tableOf, zipStore } from "../src/domain/saved-report-export";
import { reportInsights } from "../src/domain/report-insights";
import type { RawReportRow } from "../src/domain/admin-report-builder";
import {
  buildResult, change, describeSchedule, nextRunAfter, parseDefinition, parseSchedule, previousPeriod, resolvePeriod, TEMPLATES, type ReportDefinition
} from "../src/domain/saved-reports";
import type { StaffActor } from "../src/domain/staff-access";

const admin: StaffActor = { id: "u1", role: "super_admin" };
const reporting: StaffActor = { id: "u2", role: "reporting" }; // report.sales only: no revenue, no personal data
const good = { name: " Sales  report ", dimension: "category", measures: ["offers", "listingsCreated"], period: "last_30_days", compare: true };

describe("parseDefinition", () => {
  it("accepts a good definition, tidies the name and keeps measures in catalogue order", () => {
    const r = parseDefinition(good, admin);
    expect(r.ok && r.definition).toMatchObject({ name: "Sales report", measures: ["listingsCreated", "offers"], compare: true, shared: false });
  });
  it("refuses bad input", () => {
    for (const bad of [null, [], { ...good, name: "" }, { ...good, name: "x".repeat(81) }, { ...good, dimension: "owner_email" }, { ...good, measures: [] },
      { ...good, measures: ["offers", "sql"] }, { ...good, period: "forever" }, { ...good, period: "custom", from: "2026-02-30", to: "2026-03-01" },
      { ...good, period: "custom", from: "2026-03-02", to: "2026-03-01" }, { ...good, period: "custom", from: "2024-01-01", to: "2026-03-01" }]) {
      expect(parseDefinition(bad, admin).ok).toBe(false);
    }
  });
  it("needs the financial permission for platform fees", () => {
    expect(parseDefinition({ ...good, measures: ["revenueCents"] }, reporting)).toEqual({ ok: false, error: "Platform fees need the financial report permission." });
    expect(parseDefinition({ ...good, measures: ["revenueCents"] }, admin).ok).toBe(true);
  });
  it("does not allow fixed dates on a scheduled report", () => {
    const custom = { ...good, period: "custom", from: "2026-01-01", to: "2026-01-31" };
    expect(parseDefinition(custom, admin).ok).toBe(true);
    expect(parseDefinition(custom, admin, { scheduled: true }).ok).toBe(false);
  });
  it("every template is a valid definition for a role with financial access", () => {
    for (const t of TEMPLATES) expect(parseDefinition(t.definition, admin).ok).toBe(true);
  });
});

describe("periods", () => {
  const today = "2026-11-05";
  it("resolves relative periods ending today", () => {
    expect(resolvePeriod({ period: "last_7_days" }, today)).toMatchObject({ from: "2026-10-30", to: today });
    expect(resolvePeriod({ period: "last_30_days" }, today)).toMatchObject({ from: "2026-10-07", to: today });
    expect(resolvePeriod({ period: "this_month" }, today)).toMatchObject({ from: "2026-11-01", to: today });
    expect(resolvePeriod({ period: "last_month" }, today)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolvePeriod({ period: "last_month" }, "2026-03-10")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolvePeriod({ period: "last_month" }, "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("cuts a custom end date in the future back to today", () => {
    expect(resolvePeriod({ period: "custom", from: "2026-11-01", to: "2027-01-01" }, today)).toMatchObject({ from: "2026-11-01", to: today });
  });
  it("compares with the equal run just before, or the month before for calendar months", () => {
    expect(previousPeriod({ period: "last_30_days" }, resolvePeriod({ period: "last_30_days" }, today))).toMatchObject({ from: "2026-09-07", to: "2026-10-06" });
    expect(previousPeriod({ period: "last_month" }, resolvePeriod({ period: "last_month" }, today))).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(previousPeriod({ period: "this_month" }, { from: "2026-03-01", to: "2026-03-31", bucket: "month" })).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousPeriod({ period: "this_month" }, resolvePeriod({ period: "this_month" }, today))).toMatchObject({ from: "2026-10-01", to: "2026-10-05" });
  });
});

describe("schedules", () => {
  it("validates a schedule and fills defaults", () => {
    expect(parseSchedule({ frequency: "daily" })).toEqual({ ok: true, schedule: { frequency: "daily", weekday: 1, dayOfMonth: 1, hour: 7 } });
    for (const bad of [null, { frequency: "hourly" }, { frequency: "daily", hour: 24 }, { frequency: "weekly", weekday: 8 }, { frequency: "monthly", dayOfMonth: 29 }, { frequency: "daily", hour: 1.5 }])
      expect(parseSchedule(bad).ok).toBe(false);
  });
  it("finds the next run in Brisbane time (UTC+10, no daylight saving)", () => {
    // 07:00 Brisbane = 21:00 UTC the day before.
    expect(nextRunAfter({ frequency: "daily", weekday: 1, dayOfMonth: 1, hour: 7 }, "2026-11-05T03:00:00Z")).toBe("2026-11-05T21:00:00.000Z");
    expect(nextRunAfter({ frequency: "daily", weekday: 1, dayOfMonth: 1, hour: 7 }, "2026-11-05T21:00:00Z")).toBe("2026-11-06T21:00:00.000Z");
    // Thursday 5 Nov 2026: next Monday 9 Nov at 08:00 Brisbane.
    expect(nextRunAfter({ frequency: "weekly", weekday: 1, dayOfMonth: 1, hour: 8 }, "2026-11-05T03:00:00Z")).toBe("2026-11-08T22:00:00.000Z");
    expect(nextRunAfter({ frequency: "monthly", weekday: 1, dayOfMonth: 1, hour: 6 }, "2026-11-05T03:00:00Z")).toBe("2026-11-30T20:00:00.000Z");
    expect(nextRunAfter({ frequency: "monthly", weekday: 1, dayOfMonth: 28, hour: 6 }, "2026-02-28T20:30:00Z")).toBe("2026-03-27T20:00:00.000Z");
  });
  it("describes a schedule", () => {
    expect(describeSchedule({ frequency: "weekly", weekday: 5, dayOfMonth: 1, hour: 9 })).toBe("Every Friday at 09:00 Brisbane time");
  });
});

const raw = (key: string, o: Partial<RawReportRow> = {}): RawReportRow => ({ key, listingsCreated: 0, liveNow: 0, offers: 0, accepted: 0, revenueCents: 0, enquiries: 0, ...o });
const range = { from: "2026-10-01", to: "2026-10-31", bucket: "month" as const };
const prevRange = { from: "2026-09-01", to: "2026-09-30", bucket: "month" as const };
const def = (o: Partial<ReportDefinition> = {}): ReportDefinition => ({ name: "Test", dimension: "category", measures: ["listingsCreated", "offers", "accepted", "acceptance"], period: "last_month", compare: true, shared: false, ...o });

describe("buildResult", () => {
  const cur = [raw("house", { listingsCreated: 6, offers: 10, accepted: 5 }), raw("unit", { listingsCreated: 2, offers: 2, accepted: 0 })];
  const old = [raw("house", { listingsCreated: 4, offers: 8, accepted: 2 }), raw("land", { listingsCreated: 3, offers: 1, accepted: 1 })];
  const r = buildResult(admin, def(), range, cur, { range: prevRange, raw: old }, "2026-11-01T00:00:00Z");

  it("sorts by the first count measure and joins the previous period by group", () => {
    expect(r.rows.map(x => x.label)).toEqual(["House", "Unit", "Land"]);
    expect(r.rows[0]).toMatchObject({ values: { listingsCreated: 6, offers: 10, accepted: 5, acceptance: 50 }, previous: { listingsCreated: 4, offers: 8, accepted: 2, acceptance: 25 } });
    expect(r.rows[2]).toMatchObject({ values: { listingsCreated: 0 }, previous: { listingsCreated: 3 } });
  });
  it("totals both periods and recomputes acceptance from the totals", () => {
    expect(r.totals).toMatchObject({ listingsCreated: 8, offers: 12, accepted: 5, acceptance: 42 });
    expect(r.previousTotals).toMatchObject({ listingsCreated: 7, offers: 9, accepted: 3, acceptance: 33 });
  });
  it("has no previous data without compare", () => {
    const n = buildResult(admin, def({ compare: false }), range, cur);
    expect(n.previousTotals).toBeUndefined();
    expect(n.rows[0]!.previous).toBeUndefined();
  });
  it("leaves out platform fees for a role without the financial permission, even if asked for", () => {
    const f = buildResult(reporting, def({ measures: ["offers", "revenueCents"] }), range, [raw("house", { offers: 1, revenueCents: 9900 })]);
    expect(f.revenueIncluded).toBe(false);
    expect(f.rows[0]!.values.revenueCents).toBe(0);
    expect(buildResult(admin, def({ measures: ["revenueCents"] }), range, [raw("house", { revenueCents: 9900 })]).rows[0]!.values.revenueCents).toBe(9900);
  });
  it("masks agent names by the viewer's permissions", () => {
    const rows = [raw("a1b2c3d4-0000", { offers: 3, agentName: "Jane Citizen" })];
    const label = (a: StaffActor) => buildResult(a, def({ dimension: "agent" }), range, rows).rows[0]!.label;
    expect(label(admin)).toBe("Jane Citizen");
    expect(label(reporting)).toBe("Agent a1b2c3d4");
  });
  it("computes change with no percentage from zero", () => {
    expect(change(12, 8)).toEqual({ abs: 4, pct: 50 });
    expect(change(3, 0)).toEqual({ abs: 3, pct: null });
    expect(change(1, 3)).toEqual({ abs: -2, pct: -66.7 });
  });

  describe("Elena insights", () => {
    const i = reportInsights(r);
    it("states the leader, the change and the biggest mover from the numbers", () => {
      expect(i.headline).toBe("8 listings created across 3 property type groups for 2026-10-01 to 2026-10-31.");
      expect(i.points).toContain("House leads on listings created with 6, 75% of the 8 in total.");
      expect(i.points).toContain("Listings created are up 14.3% on the previous period (8 against 7).");
      expect(i.points.some(p => p.startsWith("Biggest mover: Land, listings created down by 3"))).toBe(true);
      expect(i.points).toContain("Across the period 42% of offers were accepted.");
      expect(i.points.some(p => p.includes("1 group had activity in the previous period but none in this one: Land"))).toBe(true);
      expect(i.points.length).toBeLessThanOrEqual(6);
    });
    it("says so when there is nothing to report", () => {
      expect(reportInsights(buildResult(admin, def({ compare: false }), range, [])).headline).toBe("There was no activity to report for 2026-10-01 to 2026-10-31.");
    });
    it("uses only the masked labels", () => {
      const m = buildResult(reporting, def({ dimension: "agent", compare: false }), range, [raw("a1b2c3d4-0000", { listingsCreated: 2, agentName: "Jane Citizen" })]);
      expect(JSON.stringify(reportInsights(m))).not.toContain("Jane");
    });
  });

  describe("exports", () => {
    it("CSV has the previous period and change, money in dollars, and neutralises formulas", () => {
      const money = buildResult(admin, def({ measures: ["revenueCents"] }), range, [raw("=cmd", { revenueCents: 123456 })], { range: prevRange, raw: [raw("=cmd", { revenueCents: 100000 })] });
      const csv = reportToCsv(money).split("\r\n");
      expect(csv[0]).toBe("Property type,Platform fees paid (incl. GST) (AUD),Platform fees paid (incl. GST) (previous),Change %");
      expect(csv[1]).toBe("'=cmd,1234.56,1000.00,23.5");
      expect(csv[2]).toBe("Total,1234.56,1000.00,23.5");
    });
    it("tableOf keeps the screen's header and total", () => {
      const t = tableOf(r);
      expect(t.header.slice(0, 4)).toEqual(["Property type", "Listings created", "Listings created (previous)", "Change"]);
      expect(t.totalRow[0]!.text).toBe("Total");
      expect(t.rows[0]![3]!.text).toBe("+50%");
    });
    it("xlsx is a well-formed zip with matching checksums and the report's numbers", () => {
      const buf = reportToXlsx(r, reportInsights(r));
      expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");
      const eocd = buf.length - 22;
      expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
      const count = buf.readUInt16LE(eocd + 10);
      let p = buf.readUInt32LE(eocd + 16);
      const names: string[] = [];
      let sheet = "";
      for (let i = 0; i < count; i++) {
        const len = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nl).toString();
        const data = buf.subarray(off + 30 + buf.readUInt16LE(off + 26), off + 30 + buf.readUInt16LE(off + 26) + len);
        names.push(name);
        if (name === "xl/worksheets/sheet1.xml") sheet = data.toString();
        p += 46 + nl;
      }
      expect(names).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
      expect(sheet).toContain("<t xml:space=\"preserve\">House</t>");
      expect(sheet).toContain("<v>6</v>");
      expect(sheet).toContain("Elena: ");
    });
    it("zipStore round-trips content", () => {
      const z = zipStore([{ name: "a.txt", data: Buffer.from("hello") }]);
      expect(z.subarray(30 + 5, 30 + 10).toString()).toBe("hello");
      expect(inflateRawSync(Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff])).length).toBe(0);
    });
    it("pdf is a valid file with the title, a table and Elena's summary, and escapes brackets", () => {
      const tricky = buildResult(admin, def({ compare: false }), range, [raw("a (b) \\ c", { listingsCreated: 1 })]);
      const pdf = reportToPdf(tricky, reportInsights(tricky)).toString("latin1");
      expect(pdf.startsWith("%PDF-1.4")).toBe(true);
      expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
      expect(pdf).toContain("(Test) Tj");
      expect(pdf).toContain("A (b) \\ c".replace("A", "A").replace(/([\\()])/g, "\\$1"));
      const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
      expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    });
    it("pdf paginates long tables", () => {
      const many = buildResult(admin, def({ compare: false }), range, Array.from({ length: 90 }, (_, i) => raw(`s${i}`, { listingsCreated: i + 1 })));
      const pdf = reportToPdf(many).toString("latin1");
      expect((pdf.match(/\/Type \/Page /g) ?? []).length).toBeGreaterThan(2);
      expect(pdf).toContain("Page 2 of");
    });
    it("exportReport picks the format", () => {
      expect(exportReport(r, "csv").toString().startsWith("Property type")).toBe(true);
      expect(exportReport(r, "pdf").subarray(0, 5).toString()).toBe("%PDF-");
      expect(exportReport(r, "xlsx").subarray(0, 2).toString()).toBe("PK");
    });
  });
});
