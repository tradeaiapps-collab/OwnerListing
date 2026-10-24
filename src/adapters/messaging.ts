/** Result of one send attempt, shared by the email and SMS adapters. Error codes are a fixed vocabulary: no provider text, address or number. */
export type SendResult =
  | { status: "sent"; providerRef?: string }
  | { status: "failed"; errorCode: string; retryable: boolean }
  | { status: "not_configured" };

/** Failure reasons the adapters can report (also what the outbox stores in error_code). */
export type SendErrorCode =
  | "auth_failed" | "invalid_recipient" | "recipient_opted_out" | "rate_limited" | "provider_unavailable"
  | "timeout" | "network" | "tls_failed" | "blocked_host" | "rejected" | "invalid_message" | "no_recipient" | "unknown";

export const failed = (errorCode: SendErrorCode, retryable: boolean): SendResult => ({ status: "failed", errorCode, retryable });
