import type { DocumentRecord } from "./documents";

export interface DescriptionClaim { text: string; sourceDocId: string; sourceRef?: string }
export interface DescriptionDraft { text: string; claims: readonly DescriptionClaim[] }
/** Extracted from a report by the AI and confirmed by the owner. */
export interface ReportFinding { docId: string; adverseFindings: boolean }

export const REPORTS_NOTICE = "Building and pest reports are available. Buyers should read them.";
export const ADVERSE_NOTICE = "Some issues are noted in the inspection reports.";

const ABSOLUTE = [/\bdefect[- ]free\b/i, /\bno (defects|issues|problems)\b/i, /\bstructurally sound\b/i,
  /\b(termite|pest)[- ]free\b/i, /\bperfect condition\b/i];

/**
 * Checks an AI-written description before the owner sees it. Every claim must cite one of the
 * owner's current files, absolute condition claims are blocked, and report availability (and any
 * adverse findings) must be disclosed. The owner still approves the final text.
 */
export function checkDescription(
  draft: DescriptionDraft, docs: readonly DocumentRecord[], findings: readonly ReportFinding[]
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (draft.text.trim() && draft.claims.length === 0) problems.push("Description has no cited sources.");
  for (const c of draft.claims) {
    const d = docs.find(x => x.id === c.sourceDocId);
    if (!d) problems.push(`Claim cites an unknown file: "${c.text}".`);
    else if (d.status !== "active") problems.push(`Claim cites a replaced file: "${c.text}".`);
  }
  if (ABSOLUTE.some(re => re.test(draft.text))) {
    problems.push("Absolute condition claims are not allowed. Describe what the report says and cite it.");
  }
  const hasReports = docs.some(d => d.status === "active" && (d.kind === "building_inspection" || d.kind === "pest_report"));
  if (hasReports && !draft.text.includes(REPORTS_NOTICE)) problems.push("Must say that the reports are available.");
  if (findings.some(f => f.adverseFindings) && !draft.text.includes(ADVERSE_NOTICE)) {
    problems.push("The reports note issues, and the description must say so.");
  }
  return { ok: problems.length === 0, problems };
}
