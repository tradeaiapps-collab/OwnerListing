import { MAX_SCAN_LENGTH, scanForDiscrimination } from "../domain/discrimination-filter";
import type { WordingFilter } from "../domain/ai-pipeline";

/**
 * The anti-discrimination wording filter the AI pipeline uses (src/domain/discrimination-filter.ts). Only "block" matches
 * hold a draft; "warn" matches are advice for people writing their own text. Text too long to scan in full is held.
 */
export const discriminationWordingFilter: WordingFilter = text => {
  const r = scanForDiscrimination(text);
  const flags = r.flags.filter(f => f.severity === "block").map(f => ({ category: f.category, match: f.match, suggestion: f.suggestion }));
  return { blocked: r.blocked || text.length > MAX_SCAN_LENGTH, flags, installed: true };
};

export function getWordingFilter(): WordingFilter {
  return discriminationWordingFilter;
}
