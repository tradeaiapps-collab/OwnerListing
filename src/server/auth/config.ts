import { readAppMode } from "../../config/app-mode";
import type { GoogleConfig } from "./google";

export interface AuthEnv {
  secret: string;
  appUrl: string;
  google: GoogleConfig;
  secureCookies: boolean;
}

/** Reads auth settings from the environment. Returns null if anything is missing, so login fails closed. */
export function readAuthEnv(env: Record<string, string | undefined> = process.env): AuthEnv | null {
  const secret = env["SESSION_SECRET"];
  const clientId = env["GOOGLE_CLIENT_ID"];
  const clientSecret = env["GOOGLE_CLIENT_SECRET"];
  // The admin deployment signs in on its own host, so its redirect URI and cookies use ADMIN_APP_URL.
  const appUrl = readAppMode(env) === "admin" ? env["ADMIN_APP_URL"] : env["APP_URL"];
  if (!secret || secret.length < 32 || !clientId || !clientSecret || !appUrl) return null;
  return {
    secret,
    appUrl: appUrl.replace(/\/$/, ""),
    google: { clientId, clientSecret, redirectUri: `${appUrl.replace(/\/$/, "")}/api/auth/google/callback` },
    secureCookies: appUrl.startsWith("https://")
  };
}
