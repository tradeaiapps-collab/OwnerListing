/** Sends one verification code by SMS. We generate, hash and check the code ourselves; the provider only delivers it. */
export interface SmsPort {
  /** False until a real provider is configured. Sending is refused while false. */
  readonly configured: boolean;
  /** `toE164` is an Australian mobile in +614XXXXXXXX form. Throws if delivery fails. */
  sendCode(toE164: string, code: string): Promise<void>;
}

/** Provider choice is still open (see PROJECT_STATUS.md). Until one is wired in, nothing can be sent. */
export function createUnconfiguredSms(): SmsPort {
  return { configured: false, async sendCode() { throw new Error("SMS is not configured."); } };
}

/** Add a real provider here. Any unknown or missing setting fails closed. */
export function smsFromEnv(_env: Readonly<Record<string, string | undefined>>): SmsPort {
  return createUnconfiguredSms();
}
