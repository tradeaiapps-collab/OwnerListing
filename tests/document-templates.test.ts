import { describe, expect, it } from "vitest";
import { TEMPLATES, TEMPLATE_LABEL, documentHash, renderTemplate, templateById, templatesFor } from "../src/domain/document-templates";

const heads = templateById("purchase_heads_of_terms")!;
const good = { address: "1 Test St, Brisbane", state: "QLD", buyerName: "Ben Buyer", price: "850,000", deposit: "50,000", settlementDays: "30", conditions: "Subject to finance\nSubject to building inspection" };

describe("document templates", () => {
  it("has four templates and filters by sale or rent", () => {
    expect(TEMPLATES.map(t => t.id)).toEqual(["inspection_access_consent", "seller_disclosure_summary", "purchase_heads_of_terms", "deposit_trust_notice"]);
    expect(templatesFor("rent").map(t => t.id)).toEqual(["inspection_access_consent"]);
    expect(templatesFor("sale")).toHaveLength(4);
  });
  it("every {{field}} used in a template is declared", () => {
    for (const t of TEMPLATES) {
      const used = new Set([...JSON.stringify(t.sections).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]));
      for (const u of used) expect(t.fields.map(f => f.key), `${t.id}.${u}`).toContain(u);
    }
  });
  it("renders with the label, fills fields, and hashes the result", () => {
    const r = renderTemplate(heads, good, { state: "QLD" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.body.startsWith(TEMPLATE_LABEL)).toBe(true);
    expect(r.value.body).toContain("Buyer: Ben Buyer");
    expect(r.value.body).toContain("Price: AUD 850,000");
    expect(r.value.body).toMatch(/not binding|Nothing here binds/);
    expect(r.value.contentSha256).toBe(documentHash(r.value.title, r.value.body));
    expect(renderTemplate(heads, { ...good, price: "900,000" }, { state: "QLD" })).not.toEqual(r);
  });
  it("shows (not provided) for an empty optional field", () => {
    const r = renderTemplate(heads, { ...good, conditions: "" }, { state: "QLD" });
    expect(r.ok && r.value.body).toContain("Conditions: (not provided)");
  });
  it("rejects missing, long, markup and wrong-state values", () => {
    const r = renderTemplate(heads, { ...good, buyerName: "", price: "x".repeat(31), deposit: "<b>1</b>", state: "NSW" }, { state: "QLD" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["buyerName", "deposit", "price", "state"]);
  });
  it("does not expand fields typed inside a value", () => {
    const r = renderTemplate(heads, { ...good, buyerName: "[[x]] {{price}}" }, { state: "QLD" });
    expect(r.ok).toBe(false); // braces are refused, so a value can never smuggle in a field
  });
  it("states no statutory period or amount", () => {
    for (const t of TEMPLATES) expect(JSON.stringify(t.sections)).not.toMatch(/\b\d+[- ]?(business )?days? cooling|\bcooling-off period of\b/i);
  });
});
