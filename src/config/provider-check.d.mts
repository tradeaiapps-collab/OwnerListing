export type ProviderId = "google" | "mfa" | "payway" | "smtp" | "sms" | "abn" | "maptiles";
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
}
export function isPlaceholder(value: string): boolean;
export function checkProviders(env: Readonly<Record<string, string | undefined>>, opts?: { production?: boolean }): ProviderResult[];
export function formatReport(results: ProviderResult[]): string;
