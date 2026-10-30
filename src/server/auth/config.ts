import { readAppMode } from "../../config/app-mode";
import type { GoogleConfig } from "./google";

/** What every signed-in session needs, whichever way the person signed in. */
export interface SessionEnv {
  secret: string;
  appUrl: string;
  secureCookies: boolean;
}

export interface AuthEnv extends SessionEnv {
  google: GoogleConfig;
}

/** Session settings from the environment. Null if the secret or app URL is missing, so sessions fail closed. */
export function readSessionEnv(env: Record<string, string | undefined> = process.env): SessionEnv | null {
  const secret = env["SESSION_SECRET"];
  // The admin deployment signs in on its own host, so its redirect URI and cookies use ADMIN_APP_URL.
  const appUrl = readAppMode(env) === "admin" ? env["ADMIN_APP_URL"] : env["APP_URL"];
  if (!secret || secret.length < 32 || !appUrl) return null;
  return { secret, appUrl: appUrl.replace(/\/$/, ""), secureCookies: appUrl.startsWith("https://") };
}

/** Google sign-in settings. Returns null if anything is missing, so Google sign-in fails closed. */
export function readAuthEnv(env: Record<string, string | undefined> = process.env): AuthEnv | null {
  const base = readSessionEnv(env);
  const clientId = env["GOOGLE_CLIENT_ID"];
  const clientSecret = env["GOOGLE_CLIENT_SECRET"];
  if (!base || !clientId || !clientSecret) return null;
  return { ...base, google: { clientId, clientSecret, redirectUri: `${base.appUrl}/api/auth/google/callback` } };
}
