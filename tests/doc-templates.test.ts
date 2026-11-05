import { describe, expect, it } from "vitest";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import { documentHash, parseFieldValues, renderClauses, sameName, validateTemplateContent, type TemplateContent } from "../src/domain/doc-templates";

const builtins = { listing_title: "Queenslander", listing_address: "1 Test St", jurisdiction: "QLD", generated_date: "5 November 2026", owner_name: "Olive Owner" };
const content: TemplateContent = {
  fields: [{ key: "price", label: "Price", type: "money", required: true }, { key: "when", label: "Date", type: "date", required: false }, { key: "note", label: "Note", type: "text", required: false }],
  clauses: [{ id: "a", heading: "Price for {{listing_title}}", text: "{{owner_name}} agrees to {{price}} on {{when}}. {{note}}", explanation: "Plain English." }]
};

describe("template content validation", () => {
  it("accepts every starter template, which stays plain text with only declared placeholders", () => {
    for (const s of STARTER_TEMPLATES) {
      const v = validateTemplateContent(s.content);
      expect(v.ok, s.key + JSON.stringify(v)).toBe(true);
    }
    expect(new Set(STARTER_TEMPLATES.map(s => s.key)).size).toBe(STARTER_TEMPLATES.length);
  });
  it("rejects undeclared placeholders, repeated ids, reserved keys, missing explanations and malformed shapes", () => {
    const bad = (c: unknown) => { const v = validateTemplateContent(c); return v.ok ? [] : v.errors.join(" | "); };
    expect(bad({ fields: [], clauses: [{ id: "a", heading: "H", text: "{{nope}}", explanation: "x" }] })).toContain("{{nope}}");
    expect(bad({ fields: [], clauses: [{ id: "a", heading: "H", text: "t", explanation: "x" }, { id: "a", heading: "H", text: "t", explanation: "x" }] })).toContain("repeated");
    expect(bad({ fields: [{ key: "owner_name", label: "L", type: "text" }], clauses: [{ id: "a", heading: "H", text: "t", explanation: "x" }] })).toContain("reserved");
    expect(bad({ fields: [], clauses: [{ id: "a", heading: "H", text: "t", explanation: "" }] })).toContain("explanation");
    expect(bad({ fields: [{ key: "Bad Key", label: "L", type: "text" }], clauses: [{ id: "a", heading: "H", text: "t", explanation: "x" }] })).toContain("key");
    expect(bad({ fields: [{ key: "kk", label: "L", type: "html" }], clauses: [{ id: "a", heading: "H", text: "t", explanation: "x" }] })).toContain("type");
    expect(bad({ fields: [], clauses: [] })).toContain("clauses");
    expect(bad("nope")).toContain("fields list");
  });
});

describe("field values and rendering", () => {
  it("formats money and dates, requires required fields, and rejects bad values", () => {
    const ok = parseFieldValues(content, { price: "650000", when: "2026-12-01" });
    expect(ok).toEqual({ ok: true, value: { price: "$650,000", when: "1 December 2026" } });
    expect(parseFieldValues(content, { price: "1250.50" })).toEqual({ ok: true, value: { price: "$1,250.50" } });
    expect(parseFieldValues(content, {}).ok).toBe(false);
    expect(parseFieldValues(content, { price: "12abc" }).ok).toBe(false);
    expect(parseFieldValues(content, { price: "5", when: "2026-13-45" }).ok).toBe(false);
    expect(parseFieldValues(content, { price: "5", note: "x".repeat(201) }).ok).toBe(false);
  });
  it("renders in one pass: a typed value that looks like a placeholder or replacement pattern is inserted as written", () => {
    const v = parseFieldValues(content, { price: "5", note: "{{owner_name}} $& $1" });
    if (!v.ok) throw new Error("values");
    const [c] = renderClauses(content, v.value, builtins);
    expect(c!.heading).toBe("Price for Queenslander");
    expect(c!.text).toContain("Olive Owner agrees to $5 on (not provided).");
    expect(c!.text).toContain("{{owner_name}} $& $1");
  });
  it("hashes the title and clause text, so any change gives a different hash but explanations do not matter", () => {
    const [c] = renderClauses(content, { price: "$5" }, builtins);
    const h = documentHash("T", [c!]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(documentHash("T", [{ ...c!, text: c!.text + "." }])).not.toBe(h);
    expect(documentHash("T2", [c!])).not.toBe(h);
    expect(documentHash("T", [{ ...c!, explanation: "different" }])).toBe(h);
  });
  it("compares names ignoring case and spacing", () => {
    expect(sameName("  olive   OWNER ", "Olive Owner")).toBe(true);
    expect(sameName("Olive", "Olive Owner")).toBe(false);
    expect(sameName("", "")).toBe(false);
  });
});
