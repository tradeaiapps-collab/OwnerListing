/** Same rule as the messaging settings (kept here so browser pages can import this file without server-only modules). */
const EMAIL_RE = /^[^\s\x00-\x1f\x7f<>"',;()\\@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

/** Account types anyone can create for themselves. "vendor" is a contractor (photographer, inspector, pest control, other trade). Staff are always pre-provisioned. */
export const SELF_SIGNUP_TYPES = ["buyer", "owner", "agent", "vendor"] as const;
export type SelfSignupType = (typeof SELF_SIGNUP_TYPES)[number];
export const isSelfSignupType = (v: unknown): v is SelfSignupType => typeof v === "string" && (SELF_SIGNUP_TYPES as readonly string[]).includes(v);

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Trimmed and lower-cased; null unless it looks like a single deliverable address. */
export function normaliseEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** Length rules only (NIST 800-63B): at least 10 characters, at most 128, not just the email address. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for your password.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters for your password.`;
  if (email && password.trim().toLowerCase() === email) return "Your password cannot be your email address.";
  return null;
}

/** The trade a contractor signs up under (the same four as the contractor profile). Never accepted for any other account type. */
export const SIGNUP_TRADES = ["photographer", "inspector", "pest_control", "other"] as const;
export type SignupTrade = (typeof SIGNUP_TRADES)[number];
export const isSignupTrade = (v: unknown): v is SignupTrade => typeof v === "string" && (SIGNUP_TRADES as readonly string[]).includes(v);

export interface SignupInput { email: string; name: string; password: string; userType: SelfSignupType; trade: SignupTrade | null }

/** Checks a sign-up request body. Returns the cleaned input or the first problem, worded for the person filling in the form. */
export function readSignup(body: unknown): { ok: true; value: SignupInput } | { ok: false; message: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof b["name"] === "string" ? b["name"].replace(/\s+/g, " ").trim() : "";
  if (name.length < 2 || name.length > 80 || /[\u0000-\u001f<>]/.test(name)) return { ok: false, message: "Enter your name (2 to 80 characters)." };
  const email = normaliseEmail(b["email"]);
  if (!email) return { ok: false, message: "Enter a valid email address." };
  if (!isSelfSignupType(b["userType"])) return { ok: false, message: "Choose whether you are buying or renting, an owner, an agent or a contractor." };
  if (b["userType"] === "vendor" && !isSignupTrade(b["trade"])) return { ok: false, message: "Choose your trade." };
  const problem = passwordProblem(b["password"], email);
  if (problem) return { ok: false, message: problem };
  return { ok: true, value: { email, name, password: b["password"] as string, userType: b["userType"], trade: b["userType"] === "vendor" && isSignupTrade(b["trade"]) ? b["trade"] : null } };
}

/** Where a newly signed-in person lands when no return path was asked for. */
export const homeFor = (userType: "owner" | "agent" | "buyer" | "vendor"): string =>
  userType === "buyer" ? "/buyer/saved-searches" : userType === "owner" ? "/listings/new" : userType === "vendor" ? "/contractor/profile" : "/dashboard";

export const SIGNUP_LINK_HOURS = 24;
export const RESET_LINK_MINUTES = 60;
/** Per IP and per address. Login: 20 tries per IP and 8 per address in 10 minutes. Links: 10 per IP and 3 per address an hour. */
export const EMAIL_AUTH_RATE = {
  login: { windowMs: 15 * 60 * 1000, perIp: 20, perEmail: 8, perPair: 5 },
  link: { windowMs: 60 * 60 * 1000, perIp: 10, perEmail: 3, perPair: 3 }
} as const;
