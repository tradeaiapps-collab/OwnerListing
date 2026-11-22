import type { AiEnginePort } from "./ai-engine";
import { CONTACT_RE, fenceData, isEngineUsable } from "./ai-engine";

/**
 * Elena reading a building or pest inspection report. She may only restate what the report says: every finding she returns must be
 * backed by a sentence in the report text (checked here, not trusted), and the owner decides whether any of it goes into the ad.
 */
export const MAX_REPORT_CHARS = 24_000;
export const MAX_FINDINGS = 8;

export interface ReportFinding { text: string }
export type ReportReading =
  | { state: "ok"; findings: ReportFinding[] }
  | { state: "no_text" }       // scanned or empty PDF: nothing readable
  | { state: "unavailable" };  // AI off or failed: the owner reads the report themselves

const STOP = new Set("the and for with that this are was were has have not from into over under there their than then also been will may can any all".split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%.\s]/g, " ").split(/\s+/).map(w => w.replace(/^\.+|\.+$/g, "")).filter(w => w.length > 2 && !STOP.has(w));

/** A finding is kept only if at least 70% of its content words, and every number in it, appear together in one window of the report. */
export function isGrounded(finding: string, source: string): boolean {
  const fw = words(finding);
  if (fw.length < 3) return false;
  const figures = (t: string) => t.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const srcFigures = new Set(figures(source));
  if (figures(finding).some(n => !srcFigures.has(n))) return false;
  const src = words(source);
  const uniq = [...new Set(fw)];
  const need = Math.ceil(uniq.length * 0.7);
  for (let i = 0; i < src.length; i += 20) {
    const win = new Set(src.slice(i, i + 80));
    if (uniq.filter(w => win.has(w)).length >= need) return true;
  }
  return false;
}

const SYSTEM = [
  "You read one building or pest inspection report and list its key findings for a property owner.",
  "Return up to 8 lines, one finding per line, each under 160 characters, plain words, no numbering.",
  "Use only facts written in the report. Never add, guess or soften anything. Keep every figure exactly as written.",
  "Cover defects, safety issues, termite activity and the overall condition rating if the report gives one. If the report has none of these, return nothing."
].join(" ");

/** Pure parse of the model's reply into candidate lines. */
export function parseFindingLines(reply: string): string[] {
  return reply.split("\n").map(l => l.replace(/^[\s*•\-\d.)]+/, "").trim()).filter(l => l.length >= 8 && l.length <= 200);
}

export async function readInspectionReport(engine: AiEnginePort, reportText: string): Promise<ReportReading> {
  const source = reportText.replace(/\s+/g, " ").trim().slice(0, MAX_REPORT_CHARS);
  if (source.length < 80) return { state: "no_text" };
  if (!isEngineUsable(engine)) return { state: "unavailable" };
  let reply: string;
  try { reply = await engine.generate(`Report text:\n${fenceData(source, MAX_REPORT_CHARS)}`, { system: SYSTEM, maxTokens: 500 }); } catch { return { state: "unavailable" }; }
  const seen = new Set<string>();
  const findings: ReportFinding[] = [];
  for (const line of parseFindingLines(reply)) {
    const k = line.toLowerCase();
    if (seen.has(k) || CONTACT_RE.test(line) || !isGrounded(line, source)) continue;
    seen.add(k); findings.push({ text: line });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return { state: "ok", findings };
}

/** The paragraph the owner may add to the description. Never added without the owner's tap. */
export function findingsParagraph(findings: readonly ReportFinding[]): string {
  if (findings.length === 0) return "";
  return `Building inspection report, key findings: ${findings.map(f => f.text.replace(/[.;]+$/, "")).join("; ")}. The full report is available to buyers.`;
}
