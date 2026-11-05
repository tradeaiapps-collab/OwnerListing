/** Where customers send bank transfers. Plain settings from the environment; no secrets. Unset or malformed means bank transfer is off. */
export interface BankDetails { accountName: string; bsb: string; accountNumber: string }

export function bankDetailsFromEnv(env: Readonly<Record<string, string | undefined>>): BankDetails | null {
  const accountName = env["BANK_TRANSFER_ACCOUNT_NAME"]?.trim() ?? "";
  const bsb = (env["BANK_TRANSFER_BSB"] ?? "").replace(/[\s-]/g, "");
  const accountNumber = (env["BANK_TRANSFER_ACCOUNT_NUMBER"] ?? "").replace(/\s/g, "");
  if (!accountName || accountName.length > 80 || !/^\d{6}$/.test(bsb) || !/^\d{6,10}$/.test(accountNumber)) return null;
  return { accountName, bsb: `${bsb.slice(0, 3)}-${bsb.slice(3)}`, accountNumber };
}

export const cardPaymentsConfigured = (env: Readonly<Record<string, string | undefined>>): boolean =>
  !!(env["PAYWAY_MERCHANT_ID"] && env["PAYWAY_API_KEY"] && env["PAYWAY_WEBHOOK_SECRET"]);
