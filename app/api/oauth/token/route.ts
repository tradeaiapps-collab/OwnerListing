import { NextResponse } from "next/server";
import { TOKEN_TTL_SECONDS, API_USER_TYPES, PUBLIC_ID_RE, narrowScopes, secretMatches, signToken } from "../../../../src/domain/api-keys";
import { tokenSecret } from "../../../../src/server/api/api-client-auth";
import { getDb } from "../../../../src/server/context";
import { keyByPublicId } from "../../../../src/server/public-api-db";
import { withApi } from "../../../../src/server/api/with-api";
import { TOKEN_ISSUE_RATE } from "../../../../src/domain/rate-limit";
import { clientIp } from "../../../../src/server/client-ip";
import { withinRates } from "../../../../src/server/rate-guard";

/** OAuth 2.0 client credentials (RFC 6749 section 4.4). client_id is the key's olk_ id, client_secret its secret. Errors follow RFC 6749 section 5.2. */
const oauthError = (error: string, status: number, description: string) =>
  NextResponse.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

async function handlePost(req: Request) {
  const secret = tokenSecret();
  if (!secret) return oauthError("temporarily_unavailable", 503, "Tokens are not configured on this server.");
  const form = new URLSearchParams(await req.text().catch(() => ""));
  if (form.get("grant_type") !== "client_credentials") return oauthError("unsupported_grant_type", 400, "Use grant_type=client_credentials.");
  const clientId = form.get("client_id") ?? "";
  // Counted before any lookup or secret check: per client id and address together, per address alone, and per (well-formed) client id
  // alone, so neither cycling client ids from one address nor spreading guesses at one client over many addresses gets past the limit.
  const ip = clientIp(req);
  const db = getDb(), w = TOKEN_ISSUE_RATE.windowMs;
  const wellFormed = PUBLIC_ID_RE.test(clientId);
  const allowed = [
    await withinRates(db, "oauth-token", [`${ip}|${wellFormed ? clientId : "invalid"}`], { windowMs: w, limit: TOKEN_ISSUE_RATE.perClientAndIp }),
    await withinRates(db, "oauth-token-ip", [ip], { windowMs: w, limit: TOKEN_ISSUE_RATE.perIp }),
    wellFormed ? await withinRates(db, "oauth-token-client", [clientId], { windowMs: w, limit: TOKEN_ISSUE_RATE.perClient }) : true
  ];
  if (allowed.includes(false))
    return NextResponse.json({ error: "temporarily_unavailable", error_description: "Too many token requests. Wait a minute and try again." }, { status: 429, headers: { "cache-control": "no-store", pragma: "no-cache", "retry-after": "60" } });
  const clientSecret = form.get("client_secret") ?? "";
  if (!PUBLIC_ID_RE.test(clientId) || clientSecret.length < 20 || clientSecret.length > 100) return oauthError("invalid_client", 401, "Unknown client or wrong secret.");
  const key = await keyByPublicId(getDb(), clientId);
  if (!key || !secretMatches(clientSecret, key.secretHash) || !API_USER_TYPES.includes(key.userType)) return oauthError("invalid_client", 401, "Unknown client or wrong secret.");
  const scopes = narrowScopes(key.scopes, form.get("scope") ?? undefined);
  if (!scopes) return oauthError("invalid_scope", 403, "This key does not hold every scope asked for.");
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  return NextResponse.json(
    { access_token: signToken({ kid: key.id, scopes, exp }, secret), token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: scopes.join(" ") },
    { headers: { "cache-control": "no-store", pragma: "no-cache" } });
}

export const POST = withApi(handlePost);
