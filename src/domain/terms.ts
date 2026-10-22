export interface TermsVersion { version: string; includesAiLearningClause: boolean }
export interface TermsAcceptance { userId: string; version: string }

/** Posting is blocked until the user has accepted the current terms version. */
export function hasAcceptedCurrentTerms(
  acceptances: readonly TermsAcceptance[],
  userId: string,
  current: TermsVersion
): boolean {
  return acceptances.some(a => a.userId === userId && a.version === current.version);
}

/** AI learning is covered only if the user accepted a version that contains the AI-learning clause. */
export function aiLearningCovered(
  acceptances: readonly TermsAcceptance[],
  userId: string,
  current: TermsVersion
): boolean {
  return current.includesAiLearningClause && hasAcceptedCurrentTerms(acceptances, userId, current);
}
