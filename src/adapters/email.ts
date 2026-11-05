import { lookup } from "node:dns/promises";
import nodemailer from "nodemailer";
import { isPublicAddress } from "../domain/net-guard";
import { isEmailAddress, resolveMessaging, type SmtpConfig } from "../domain/messaging-settings";
import { failed, type SendErrorCode, type SendResult } from "./messaging";

export interface EmailMessage { to: string; subject: string; text: string; /** Optional HTML alternative; the plain text is always sent too. */ html?: string }

/** Sends one plain-text email. Provider-agnostic: a transactional HTTP API adapter can implement the same port. */
export interface EmailPort {
  readonly configured: boolean;
  /** Never throws for delivery problems: reports them as a result with a fixed error code. */
  send(msg: EmailMessage): Promise<SendResult>;
}

export function createUnconfiguredEmail(): EmailPort {
  return { configured: false, async send() { return { status: "not_configured" }; } };
}

export interface MailTransport {
  sendMail(m: { from: string; to: string; subject: string; text: string; html?: string }): Promise<{ messageId?: string }>;
  close(): void;
}
export type TransportFactory = (options: Record<string, unknown>) => MailTransport;

const defaultFactory: TransportFactory = options => nodemailer.createTransport(options as never) as unknown as MailTransport;

/** Maps a transport error to our fixed vocabulary. The error text (which can echo addresses) is never kept. */
export function mapSmtpError(e: unknown): { code: SendErrorCode; retryable: boolean } {
  const err = (e ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const rc = typeof err.responseCode === "number" ? err.responseCode : 0;
  if (code === "EAUTH" || rc === 535 || rc === 534) return { code: "auth_failed", retryable: false };
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return { code: "timeout", retryable: true };
  if (code === "ETLS" || code === "ESOCKET" && /tls|ssl|certificate/i.test(String((e as Error).message))) return { code: "tls_failed", retryable: false };
  if (code === "ECONNECTION" || code === "ESOCKET" || code === "EDNS" || code === "ECONNREFUSED" || code === "ENOTFOUND") return { code: "network", retryable: true };
  if (code === "EENVELOPE" || rc === 550 || rc === 551 || rc === 553) return { code: "invalid_recipient", retryable: false };
  if (rc >= 400 && rc < 500) return { code: "provider_unavailable", retryable: true };
  if (rc >= 500) return { code: "rejected", retryable: false };
  return { code: "unknown", retryable: false };
}

export const SMTP_TIMEOUT_MS = 10_000;

/** Resolves a host to its addresses (all of them). Injectable for tests. */
export type HostResolver = (host: string) => Promise<string[]>;
const defaultResolver: HostResolver = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address);

/**
 * SSRF guard: the admin-entered host is resolved here and EVERY address must be public. The connection is then made to that address
 * (not the name), so a second DNS answer (rebinding) cannot redirect it; the certificate is still checked against the name.
 * Returns the address to connect to, "blocked" or "unresolved".
 */
export async function pinPublicAddress(host: string, resolve: HostResolver, timeoutMs: number): Promise<string | "blocked" | "unresolved"> {
  let addrs: string[];
  try {
    addrs = await Promise.race([resolve(host), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs).unref())]);
  } catch {
    return "unresolved";
  }
  if (addrs.length === 0) return "unresolved";
  if (!addrs.every(isPublicAddress)) return "blocked";
  return addrs[0]!;
}

/**
 * SMTP adapter (nodemailer). TLS is mandatory: port 465 uses implicit TLS, any other port must upgrade with STARTTLS or the send fails
 * (credentials are never sent in clear). Timeouts on connect, greeting and socket. No automatic retry (see the SMS adapter).
 * Nothing is logged here; errors map to a fixed code.
 */
export function createSmtpEmail(cfg: SmtpConfig, deps: { createTransport?: TransportFactory; timeoutMs?: number; resolve?: HostResolver } = {}): EmailPort {
  const make = deps.createTransport ?? defaultFactory;
  const timeout = deps.timeoutMs ?? SMTP_TIMEOUT_MS;
  return {
    configured: true,
    async send(msg) {
      if (!isEmailAddress(msg.to)) return failed("invalid_recipient", false);
      if (/[\r\n]/.test(msg.subject) || msg.subject.length === 0 || msg.subject.length > 200 || msg.text.length === 0 || msg.text.length > 20_000 || (msg.html !== undefined && msg.html.length > 100_000)) return failed("invalid_message", false);
      const pinned = await pinPublicAddress(cfg.host, deps.resolve ?? defaultResolver, timeout);
      if (pinned === "blocked") return failed("blocked_host", false);
      if (pinned === "unresolved") return failed("network", true);
      const transport = make({
        host: pinned, port: cfg.port, secure: cfg.port === 465, requireTLS: cfg.port !== 465,
        ...(cfg.user !== undefined && cfg.password !== undefined ? { auth: { user: cfg.user, pass: cfg.password } } : {}),
        tls: { minVersion: "TLSv1.2", servername: cfg.host, rejectUnauthorized: true },
        connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout * 2,
        disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false
      });
      try {
        const info = await transport.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) });
        const ref = typeof info.messageId === "string" && info.messageId.length <= 200 ? info.messageId : undefined;
        return ref ? { status: "sent", providerRef: ref } : { status: "sent" };
      } catch (e) {
        const m = mapSmtpError(e);
        return failed(m.code, m.retryable);
      } finally {
        try { transport.close(); } catch { /* nothing to clean up */ }
      }
    }
  };
}

export function emailFromConfig(cfg: SmtpConfig | null, deps: Parameters<typeof createSmtpEmail>[1] = {}): EmailPort {
  return cfg ? createSmtpEmail(cfg, deps) : createUnconfiguredEmail();
}

/** Environment-only settings (SMTP_* variables). Unset or incomplete = unconfigured. */
export function emailFromEnv(env: Readonly<Record<string, string | undefined>>): EmailPort {
  return emailFromConfig(resolveMessaging({}, env).email);
}
