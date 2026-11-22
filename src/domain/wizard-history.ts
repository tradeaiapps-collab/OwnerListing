/** Browser history for the Create a listing wizard: one entry per step (#step-N), so Back and Forward move between steps. Pure. */
export const stepHash = (step: number): string => `#step-${step + 1}`;

/** The step a URL hash names, limited to steps already reached; 0 for no or an unknown hash. */
export function stepFromHash(hash: string, reached: number, last: number): number {
  const m = /^#step-(\d{1,2})$/.exec(hash);
  if (!m) return 0;
  return Math.min(Math.max(Number(m[1]) - 1, 0), Math.min(reached, last));
}
