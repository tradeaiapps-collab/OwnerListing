/**
 * Backstop for the public (general-information) AI. It must not recommend a specific loan,
 * lender or personal amount. This pattern check is a second line of defence only: the AI's
 * instructions and evaluation tests are the first. Failed output must not reach the buyer.
 */
export const PUBLIC_AI_RULES =
  "You give general information, rough ranges and strategy only. Never recommend a specific loan, lender " +
  "or personal borrowing amount. Never say what the user can borrow or afford as a figure. Refer personal " +
  "questions to a licensed broker.";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\byou\s+(can|could|will|should|are able to|may be able to)\s+(borrow|get approved for|afford)\b[^.\n]*\$\s?\d/i, "States a personal borrowing or affordability amount."],
  [/\byour\s+(borrowing capacity|borrowing power|budget)\s+(is|would be|will be)\b[^.\n]*\$\s?\d/i, "States a personal borrowing capacity."],
  [/\b(i|we)\s+(recommend|suggest|advise)\b[^.\n]*\b(loan|lender|mortgage|bank|broker's product)\b/i, "Recommends a specific loan or lender."],
  [/\bbest\s+(loan|lender|mortgage|rate)\s+for\s+you\b/i, "Claims a best loan or lender for the user."]
];

export interface GuardResult { ok: boolean; violations: string[] }

export function checkPublicOutput(text: string, lenderNames: readonly string[] = []): GuardResult {
  const violations = PATTERNS.filter(([re]) => re.test(text)).map(([, msg]) => msg);
  const lower = text.toLowerCase();
  for (const name of lenderNames) {
    if (name && lower.includes(name.toLowerCase())) violations.push(`Names a specific lender: ${name}.`);
  }
  return { ok: violations.length === 0, violations };
}
