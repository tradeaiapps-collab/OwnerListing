import { createHmac, randomUUID } from "node:crypto";
import type { EmailPort } from "../adapters/email";
import { scanContent } from "../domain/content-filter";
import { passwordResetEmail, signupExistingEmail, signupVerifyEmail } from "../domain/account-emails";
import type { RenderedEmail } from "../domain/email-templates";
import { EMAIL_AUTH_RATE, RESET_LINK_MINUTES, SIGNUP_LINK_HOURS, normaliseEmail, passwordProblem, readSignup } from "../domain/email-auth";
import { windowStart, withinLimit } from "../domain/rate-limit";
import { hashPassword, verifyPassword } from "./auth/password";
import { randomToken } from "./auth/session";
import { appendAuditPg, type Queryable } from "./db";
import { countHitPg } from "./offer-flow-db";

/**
 * Email and password sign-up, sign-in and password reset. Every statement is parameterised.
 * Nothing here says whether an address has an account: sign-up and reset always answer the same way, and a failed sign-in is
 * one generic message.
 */
export interface EmailAuthDeps {
  db: Queryable;
  email: EmailPort;
  /** SESSION_SECRET: keys the token and rate-limit hashes. */
  secret: string;
  appUrl: string;
  brand: string;
  /** Local development only: when email is not set up, the link is handed here (the console) instead of being sent. */
  devLink?: (purpose: "signup" | "reset", link: string) => void;
  /** Called once when an address first goes over the sign-in limit in a window (the admin alert). Must not throw or block. */
  onLockout?: (email: string) => void;
  now?: () => Date;
}

export type EmailAuthResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: "invalid" | "rate_limited" | "not_configured" | "bad_credentials" | "link_invalid" | "account_exists"; message: string };

const fail = (code: Exclude<EmailAuthResult, { ok: true }>["code"], message: string) => ({ ok: false as const, code, message });
const keyed = (secret: string, label: string, v: string) => createHmac("sha256", secret).update(`email-auth:${label}:${v}`).digest("hex");
const nowOf = (d: EmailAuthDeps) => (d.now ?? (() => new Date()))();

async function allowed(d: EmailAuthDeps, kind: keyof typeof EMAIL_AUTH_RATE, ip: string, email: string): Promise<boolean> {
  const r = EMAIL_AUTH_RATE[kind];
  const start = windowStart(nowOf(d).toISOString(), r.windowMs);
  // Both buckets are counted every time, so a refused attempt still uses up the other limit. Bucket names are keyed hashes (64 characters).
  const byIp = await countHitPg(d.db, keyed(d.secret, `rate:${kind}:ip`, ip), start);
  const byEmail = await countHitPg(d.db, keyed(d.secret, `rate:${kind}:email`, email), start);
  // The pair bucket stops one address being hammered from one place even while both single limits still have room.
  const byPair = await countHitPg(d.db, keyed(d.secret, `rate:${kind}:pair`, `${ip}|${email}`), start);
  if (kind === "login" && byEmail === r.perEmail + 1 && d.onLockout) {
    // At most one alert per window across all addresses, so many addresses cannot flood the admins.
    if ((await countHitPg(d.db, keyed(d.secret, "rate:lockout-alert", "all"), start)) === 1) d.onLockout(email);
  }
  return withinLimit(byIp, r.perIp) && withinLimit(byEmail, r.perEmail) && withinLimit(byPair, r.perPair);
}

/** Sends the message, or hands the link to the local-development console. False when there is no way to deliver it. */
async function deliver(d: EmailAuthDeps, purpose: "signup" | "reset", to: string, msg: RenderedEmail, link: string): Promise<boolean> {
  if (d.email.configured) return (await d.email.send({ to, ...msg })).status === "sent";
  if (d.devLink) { d.devLink(purpose, link); return true; }
  return false;
}

const canDeliver = (d: EmailAuthDeps) => d.email.configured || d.devLink !== undefined;
const notConfigured = () => fail("not_configured", "Email sign-up is not available yet. Continue with Google instead.");
const audit = (db: Queryable, userId: string, eventType: string, at: Date) => appendAuditPg(db, {
  id: randomUUID(), occurredAt: at.toISOString(), actorType: "user", actorId: userId, aggregateType: "user_session", aggregateId: userId,
  eventType, correlationId: randomUUID(), payload: {}
});

/**
 * Step 1 of sign-up. The account is not created yet: the details wait with a one-time link sent to the address, so only someone
 * who can read that inbox can create it. If the address already has an account, that inbox is told so instead.
 */
export async function startSignup(d: EmailAuthDeps, body: unknown, ip: string): Promise<EmailAuthResult> {
  const r = readSignup(body);
  if (!r.ok) return fail("invalid", r.message);
  if (!canDeliver(d)) return notConfigured();
  const { email, name, password, userType } = r.value;
  // The display name is shown to other people. Abuse and contact details are refused; the account is not created yet, so nothing is stored.
  if (scanContent(name).action === "block") return fail("invalid", "That name can't be used. Please use your real name, without contact details or offensive words.");
  if (!(await allowed(d, "link", ip, email))) return fail("rate_limited", "Too many attempts. Try again in an hour.");

  // Hashed before the lookup, so a known and a new address take the same time.
  const passwordHash = await hashPassword(password);
  const existing = await d.db.query("SELECT 1 FROM app_user WHERE email = $1", [email]);
  if (existing.rows.length > 0) {
    await deliver(d, "signup", email, signupExistingEmail(d.brand, d.appUrl), `${d.appUrl}/login`);
    return { ok: true };
  }
  const token = randomToken();
  const at = nowOf(d);
  await d.db.query(
    `INSERT INTO email_auth_token (purpose, email, display_name, user_type, password_hash, token_hash, expires_at)
     VALUES ('signup', $1, $2, $3, $4, $5, $6)`,
    [email, name, userType, passwordHash, keyed(d.secret, "token", token), new Date(at.getTime() + SIGNUP_LINK_HOURS * 3600_000).toISOString()]
  );
  const link = `${d.appUrl}/signup/verify?token=${encodeURIComponent(token)}`;
  await deliver(d, "signup", email, signupVerifyEmail(d.brand, link, SIGNUP_LINK_HOURS), link);
  return { ok: true };
}

/** Step 2 of sign-up: uses the link and creates the account. The caller signs the person in. */
export async function completeSignup(d: EmailAuthDeps, token: unknown): Promise<EmailAuthResult<{ user: { id: string; userType: "owner" | "agent" | "buyer" } }>> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return fail("link_invalid", "This link is not valid. Sign up again to get a new one.");
  if (!d.db.transaction) throw new Error("Transactions are required.");
  const at = nowOf(d);
  return d.db.transaction(async tx => {
    const t = (await tx.query(
      `UPDATE email_auth_token SET consumed_at = $3
        WHERE token_hash = $1 AND purpose = 'signup' AND consumed_at IS NULL AND expires_at > $2
        RETURNING email::text AS email, display_name, user_type, password_hash`,
      [keyed(d.secret, "token", token), at.toISOString(), at.toISOString()]
    )).rows[0];
    if (!t) return fail("link_invalid", "This link has expired or was already used. Sign up again to get a new one.");
    const created = (await tx.query(
      `INSERT INTO app_user (email, display_name, user_type, status, password_hash)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, user_type`,
      [t["email"], t["display_name"], t["user_type"], t["password_hash"]]
    )).rows[0];
    if (!created) return fail("account_exists", "This email already has an account. Sign in instead.");
    // Any other sign-up link for the same address stops working.
    await tx.query("UPDATE email_auth_token SET consumed_at = $2 WHERE email = $1 AND purpose = 'signup' AND consumed_at IS NULL", [t["email"], at.toISOString()]);
    const user = { id: String(created["id"]), userType: created["user_type"] as "owner" | "agent" | "buyer" };
    await audit(tx, user.id, "user.signed_up", at);
    return { ok: true as const, user };
  });
}

/** Email and password sign-in for owner, agent and buyer accounts. One generic failure for every reason. */
export async function passwordSignIn(d: EmailAuthDeps, body: unknown, ip: string): Promise<EmailAuthResult<{ user: { id: string; userType: "owner" | "agent" | "buyer" } }>> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const email = normaliseEmail(b["email"]);
  const password = typeof b["password"] === "string" && b["password"].length <= 1024 ? b["password"] : "";
  if (!email || !password) return fail("invalid", "Enter your email and password.");
  if (!(await allowed(d, "login", ip, email))) return fail("rate_limited", "Too many attempts. Wait 15 minutes and try again, or reset your password.");
  const row = (await d.db.query(
    `SELECT id, user_type, password_hash FROM app_user
      WHERE email = $1 AND status = 'active' AND deleted_at IS NULL AND user_type IN ('owner', 'agent', 'buyer')`,
    [email]
  )).rows[0];
  const hash = typeof row?.["password_hash"] === "string" ? row["password_hash"] : null;
  if (!(await verifyPassword(password, hash)) || !row) return fail("bad_credentials", "Email or password is incorrect.");
  const user = { id: String(row["id"]), userType: row["user_type"] as "owner" | "agent" | "buyer" };
  await audit(d.db, user.id, "user.signed_in_password", nowOf(d));
  return { ok: true, user };
}

/** Sends a reset link when the address belongs to an owner, agent or buyer account (Google-only accounts can add a password this way). */
export async function requestPasswordReset(d: EmailAuthDeps, body: unknown, ip: string): Promise<EmailAuthResult> {
  const email = normaliseEmail((body as Record<string, unknown> | null)?.["email"]);
  if (!email) return fail("invalid", "Enter a valid email address.");
  if (!canDeliver(d)) return fail("not_configured", "Password reset by email is not available yet.");
  if (!(await allowed(d, "link", ip, email))) return fail("rate_limited", "Too many attempts. Try again in an hour.");
  const row = (await d.db.query(
    `SELECT id FROM app_user WHERE email = $1 AND status = 'active' AND deleted_at IS NULL AND user_type IN ('owner', 'agent', 'buyer')`, [email]
  )).rows[0];
  if (!row) return { ok: true };
  const token = randomToken();
  const at = nowOf(d);
  await d.db.query(
    `INSERT INTO email_auth_token (purpose, email, user_id, token_hash, expires_at) VALUES ('reset', $1, $2, $3, $4)`,
    [email, row["id"], keyed(d.secret, "token", token), new Date(at.getTime() + RESET_LINK_MINUTES * 60_000).toISOString()]
  );
  const link = `${d.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await deliver(d, "reset", email, passwordResetEmail(d.brand, link, RESET_LINK_MINUTES), link);
  return { ok: true };
}

/** Sets the new password and signs the account out everywhere. Two-step sign-in is unchanged and still asked for at the next sign-in. */
export async function completePasswordReset(d: EmailAuthDeps, body: unknown): Promise<EmailAuthResult> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const token = b["token"];
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return fail("link_invalid", "This link is not valid. Ask for a new one.");
  const problem = passwordProblem(b["password"]);
  if (problem) return fail("invalid", problem);
  if (!d.db.transaction) throw new Error("Transactions are required.");
  const hash = await hashPassword(b["password"] as string);
  const at = nowOf(d);
  return d.db.transaction(async tx => {
    const t = (await tx.query(
      `SELECT id, user_id, email::text AS email FROM email_auth_token
        WHERE token_hash = $1 AND purpose = 'reset' AND consumed_at IS NULL AND expires_at > $2
        FOR UPDATE`,
      [keyed(d.secret, "token", token), at.toISOString()]
    )).rows[0];
    if (!t) return fail("link_invalid", "This link has expired or was already used. Ask for a new one.");
    const same = passwordProblem(b["password"], String(t["email"]));
    if (same) return fail("invalid", same);
    // This link and any other reset link for the account stop working.
    await tx.query("UPDATE email_auth_token SET consumed_at = $2 WHERE user_id = $1 AND purpose = 'reset' AND consumed_at IS NULL", [t["user_id"], at.toISOString()]);
    const updated = (await tx.query(
      `UPDATE app_user SET password_hash = $2, password_changed_at = $3
        WHERE id = $1 AND email = $4 AND status = 'active' AND deleted_at IS NULL RETURNING id`,
      [t["user_id"], hash, at.toISOString(), t["email"]]
    )).rows[0];
    if (!updated) return fail("link_invalid", "This link is no longer valid. Ask for a new one.");
    await audit(tx, String(t["user_id"]), "user.password_reset", at);
    return { ok: true as const };
  });
}
