import { wordingFilterNotInstalled, type WordingFilter } from "../domain/ai-pipeline";

/**
 * The anti-discrimination wording filter the AI pipeline uses. The filter itself is built separately
 * (src/domain/discrimination-filter.ts, scanForDiscrimination). Until it is wired in here, every AI draft is held
 * with "wording filter not installed": AI text never reaches a buyer unchecked.
 */
export function getWordingFilter(): WordingFilter {
  return wordingFilterNotInstalled;
}
