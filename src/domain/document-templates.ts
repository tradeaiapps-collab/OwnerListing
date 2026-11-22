import { createHash } from "node:crypto";
import type { Jurisdiction } from "./jurisdiction";

/**
 * Document templates for a sale or rental. Plain text with {{fields}}. They are conveniences, not legal documents:
 * the purchase template is "heads of terms, subject to contract", the disclosure template does not replace the statutory forms
 * a solicitor prepares, and no template states a statutory period or amount (those depend on the state and are left to the solicitor).
 * Counsel review is tracked in docs/COUNSEL_QUESTIONS.md. Pure functions.
 */
export const TEMPLATE_LABEL = "Template for convenience. Not legal advice. Have your solicitor or conveyancer review it before anyone signs.";

export interface TemplateField {
  key: string;
  label: string;
  required: boolean;
  maxLength: number;
  multiline?: boolean;
  /** Filled in from the listing when the form opens. The person can change it. */
  prefill?: "address" | "state" | "title";
}
export interface TemplateSection { heading: string; lines: string[] }
export interface DocTemplate {
  id: string;
  title: string;
  summary: string;
  version: string;
  transaction: "sale" | "rent" | "both";
  fields: TemplateField[];
  sections: TemplateSection[];
  signerRoles: string[];
}

const f = (key: string, label: string, required: boolean, maxLength: number, extra: Partial<TemplateField> = {}): TemplateField =>
  ({ key, label, required, maxLength, ...extra });

export const TEMPLATES: readonly DocTemplate[] = [
  {
    id: "inspection_access_consent", version: "2026-11-v1", transaction: "both",
    title: "Inspection access consent",
    summary: "The owner agrees to an inspection at a set time and the visitor agrees to the access rules.",
    fields: [
      f("address", "Property address", true, 200, { prefill: "address" }),
      f("inspectionType", "Type of inspection", true, 80),
      f("dateTime", "Date and time", true, 80),
      f("visitorName", "Name of the person visiting", true, 120),
      f("conditions", "Access conditions", false, 500, { multiline: true })
    ],
    sections: [
      { heading: "Inspection", lines: ["Property: {{address}}", "Type: {{inspectionType}}", "Date and time: {{dateTime}}", "Visitor: {{visitorName}}"] },
      { heading: "Access", lines: [
        "The owner allows the visitor to enter the property at the time above for the inspection only.",
        "The visitor will follow the owner's reasonable directions, leave the property as found and report any damage they cause.",
        "Access conditions: {{conditions}}"
      ] },
      { heading: "Records", lines: ["Photos taken during the inspection are for the inspection report and the parties to this sale only."] }
    ],
    signerRoles: ["Owner", "Visitor"]
  },
  {
    id: "seller_disclosure_summary", version: "2026-11-v1", transaction: "sale",
    title: "Seller disclosure summary",
    summary: "The owner lists what they know about the property. It does not replace the disclosure forms a solicitor prepares.",
    fields: [
      f("address", "Property address", true, 200, { prefill: "address" }),
      f("state", "State or territory", true, 3, { prefill: "state" }),
      f("knownDefects", "Known defects or damage", false, 1000, { multiline: true }),
      f("worksDone", "Building work or renovations in the last 7 years", false, 1000, { multiline: true }),
      f("disputes", "Disputes, notices or orders affecting the property", false, 1000, { multiline: true })
    ],
    sections: [
      { heading: "Property", lines: ["Address: {{address}} ({{state}})"] },
      { heading: "What the owner knows", lines: [
        "Known defects or damage: {{knownDefects}}", "Building work in the last 7 years: {{worksDone}}", "Disputes, notices or orders: {{disputes}}"
      ] },
      { heading: "Statement", lines: [
        "The owner confirms this summary is true and complete to the best of their knowledge.",
        "This summary is in addition to, and does not replace, the disclosure statements and certificates required by the law of {{state}}. The owner's solicitor or conveyancer prepares those."
      ] }
    ],
    signerRoles: ["Owner"]
  },
  {
    id: "purchase_heads_of_terms", version: "2026-11-v1", transaction: "sale",
    title: "Purchase heads of terms (subject to contract)",
    summary: "The main terms the owner and buyer have discussed. It is not a contract of sale.",
    fields: [
      f("address", "Property address", true, 200, { prefill: "address" }),
      f("state", "State or territory", true, 3, { prefill: "state" }),
      f("buyerName", "Buyer's full name", true, 120),
      f("price", "Price (AUD)", true, 30),
      f("deposit", "Deposit (AUD)", true, 30),
      f("settlementDays", "Days to settlement", true, 4),
      f("conditions", "Conditions (finance, inspections, other)", false, 1000, { multiline: true })
    ],
    sections: [
      { heading: "Parties and property", lines: ["Buyer: {{buyerName}}", "Property: {{address}} ({{state}})"] },
      { heading: "Terms", lines: [
        "Price: AUD {{price}}", "Deposit: AUD {{deposit}}, paid to the solicitor's or conveyancer's trust account (not to the owner and not to this website)",
        "Settlement: {{settlementDays}} days after the contract is made", "Conditions: {{conditions}}"
      ] },
      { heading: "Subject to contract", lines: [
        "These are the terms the parties intend to put into a contract of sale prepared by their solicitors or conveyancers.",
        "Nothing here binds either party to buy or sell. A contract exists only when a contract of sale is signed and exchanged under the law of {{state}}.",
        "Any cooling-off right and other statutory rights are set by that contract and that law, and are not changed by this document."
      ] }
    ],
    signerRoles: ["Owner", "Buyer"]
  },
  {
    id: "deposit_trust_notice", version: "2026-11-v1", transaction: "sale",
    title: "Deposit and trust account notice",
    summary: "The buyer acknowledges where the deposit must be paid and that this website never holds money.",
    fields: [
      f("address", "Property address", true, 200, { prefill: "address" }),
      f("buyerName", "Buyer's full name", true, 120),
      f("deposit", "Deposit (AUD)", true, 30),
      f("trustHolder", "Solicitor or conveyancer holding the trust account", true, 160),
      f("dueDate", "Date the deposit is due", true, 40)
    ],
    sections: [
      { heading: "Deposit", lines: ["Property: {{address}}", "Buyer: {{buyerName}}", "Deposit: AUD {{deposit}}, due {{dueDate}}", "Paid to the trust account held by: {{trustHolder}}"] },
      { heading: "Acknowledgement", lines: [
        "The buyer understands the deposit is paid to the trust account named above and not to the owner.",
        "This website never receives, holds or transfers deposits or any other money for the sale.",
        "The buyer should confirm the account details by phone with the solicitor or conveyancer before paying. Account details are never sent by chat or email through this website."
      ] }
    ],
    signerRoles: ["Buyer"]
  }
];

export const templateById = (id: string): DocTemplate | undefined => TEMPLATES.find(t => t.id === id);
export const templatesFor = (transaction: "sale" | "rent"): DocTemplate[] => TEMPLATES.filter(t => t.transaction === "both" || t.transaction === transaction);

/** Control characters (except newline in multiline fields) and angle brackets, braces and backticks are refused in field values. */
const SINGLE = /^[^\u0000-\u001f\u007f<>{}`]*$/;
const MULTI = /^[^\u0000-\u0009\u000b-\u001f\u007f<>{}`]*$/;

export interface Rendered { title: string; body: string; fields: Record<string, string>; contentSha256: string }

export function documentHash(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`, "utf8").digest("hex");
}

/** Checks the field values and builds the document text. Each template line is filled in once; values are never scanned for fields again. */
export function renderTemplate(
  t: DocTemplate, input: unknown, ctx: { state: Jurisdiction }
): { ok: true; value: Rendered } | { ok: false; errors: Record<string, string> } {
  const raw = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const fld of t.fields) {
    const v = raw[fld.key];
    const text = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
    if (v !== undefined && typeof v !== "string") errors[fld.key] = "Must be text.";
    else if (!text && fld.required) errors[fld.key] = "Required.";
    else if (text.length > fld.maxLength) errors[fld.key] = `At most ${fld.maxLength} characters.`;
    else if (!(fld.multiline ? MULTI : SINGLE).test(text)) errors[fld.key] = "Plain text only.";
    else values[fld.key] = text;
  }
  if (t.fields.some(x => x.key === "state") && values["state"] && values["state"] !== ctx.state) errors["state"] = `Must match the listing's state (${ctx.state}).`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const fill = (line: string) => line.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => values[k] || "(not provided)");
  const body = [
    TEMPLATE_LABEL, "",
    ...t.sections.flatMap(s => [s.heading.toUpperCase(), ...s.lines.map(fill), ""])
  ].join("\n").trimEnd();
  return { ok: true, value: { title: t.title, body, fields: values, contentSha256: documentHash(t.title, body) } };
}
