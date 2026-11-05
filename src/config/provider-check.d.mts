export type ProviderId = "google" | "mfa" | "payway" | "smtp" | "sms" | "webpush" | "fcm" | "apns" | "abn" | "docusign" | "domain" | "address" | "maptiles";
export type ProviderStatus = "ready" | "off" | "incomplete" | "invalid";
export interface ProviderResult {
  id: ProviderId;
  label: string;
  required: boolean;
  unlocks: string;
  whenOff: string;
  alsoIn: string | null;
  keys: string[];
  status: ProviderStatus;
  missing: string[];
  problems: string[];
  blocking: boolean;
  /** A caveat for a ready provider (e.g. OpenStreetMap's public tile policy), or null. */
  note: string | null;
}
export function isPlaceholder(value: string): boolean;
export function checkProviders(env: Readonly<Record<string, string | undefined>>, opts?: { production?: boolean }): ProviderResult[];
export function formatReport(results: ProviderResult[]): string;
