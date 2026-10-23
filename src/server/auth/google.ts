import { createHash } from "node:crypto";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Must exactly match an authorised redirect URI in the Google Cloud console. */
  redirectUri: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function buildAuthUrl(cfg: GoogleConfig, s: { state: string; nonce: string; verifier: string }): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: s.state,
    nonce: s.nonce,
    code_challenge: pkceChallenge(s.verifier),
    code_challenge_method: "S256",
    prompt: "select_account"
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * Checks the ID token claims. The token is received directly from Google's token endpoint over TLS, which the OIDC
 * spec accepts in place of signature verification, so only the claims are checked here.
 */
export function readIdentity(
  claims: Record<string, unknown>, expect: { clientId: string; nonce: string; nowSeconds: number }
): GoogleIdentity | null {
  const { iss, aud, exp, nonce, sub, email, email_verified: verified, name } = claims;
  if (typeof iss !== "string" || !ISSUERS.includes(iss)) return null;
  if (aud !== expect.clientId) return null;
  if (typeof exp !== "number" || exp <= expect.nowSeconds) return null;
  if (nonce !== expect.nonce) return null;
  if (typeof sub !== "string" || !sub) return null;
  if (typeof email !== "string" || !email || verified !== true) return null;
  return { sub, email, name: typeof name === "string" && name.trim() ? name.trim() : email };
}

export function decodeIdToken(idToken: string): Record<string, unknown> | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Exchanges the authorisation code (with the PKCE verifier) for the ID token claims. */
export async function exchangeCode(
  cfg: GoogleConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code", code_verifier: verifier
    })
  });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const idToken = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["id_token"] : undefined;
  return typeof idToken === "string" ? decodeIdToken(idToken) : null;
}
