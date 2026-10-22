export const AU_JURISDICTIONS = [
  "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"
] as const;

export type Jurisdiction = typeof AU_JURISDICTIONS[number];

export function isJurisdiction(value: string): value is Jurisdiction {
  return (AU_JURISDICTIONS as readonly string[]).includes(value);
}
