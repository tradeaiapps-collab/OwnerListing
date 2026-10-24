import { readAppMode, type AppMode } from "../config/app-mode";

/**
 * DEV-ONLY test sign-in (local test kit, docs/LOCAL_TEST.md). Every condition must hold or the page and API answer 404:
 *  - NODE_ENV is not "production";
 *  - DEV_LOGIN is exactly "1";
 *  - VERCEL is not set (never on a Vercel deployment, whatever else is set);
 *  - the Host header AND the request URL host are localhost, 127.0.0.1 or [::1], and no X-Forwarded-Host says otherwise;
 *  - APP_URL (and ADMIN_APP_URL in admin mode) are localhost origins too, so a deployment configured for a real domain can never enable it.
 */
export const DEV_EMAIL_DOMAIN = "@demo.invalid";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const hostnameOf = (hostHeader: string | null | undefined): string | null => {
  if (!hostHeader || /[@/\\?#\s]/.test(hostHeader.trim())) return null; // no userinfo/path tricks such as evil.com@localhost
  try { return new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase(); } catch { return null; }
};
const isLocalHost = (h: string | null) => h !== null && LOCAL_HOSTS.has(h);
const isLocalOrigin = (raw: string | undefined) => {
  if (!raw) return false;
  try { return isLocalHost(new URL(raw).hostname.toLowerCase()); } catch { return false; }
};

/** True only for a request that may use dev sign-in. Pure: reads only the arguments. */
export function devLoginAllowed(req: { url: string; headers: { get(name: string): string | null } }, env: Record<string, string | undefined> = process.env): boolean {
  if (env["NODE_ENV"] === "production") return false;
  if (env["DEV_LOGIN"] !== "1") return false;
  if (env["VERCEL"]) return false;
  const mode = readAppMode(env);
  if (!isLocalOrigin(env["APP_URL"])) return false;
  if (mode === "admin" && !isLocalOrigin(env["ADMIN_APP_URL"])) return false;
  if (!isLocalHost(hostnameOf(req.headers.get("host")))) return false;
  let urlHost: string | null = null;
  try { urlHost = new URL(req.url).hostname.toLowerCase(); } catch { /* falls through to refuse */ }
  if (!isLocalHost(urlHost)) return false;
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd !== null && !fwd.split(",").every(h => isLocalHost(hostnameOf(h)))) return false;
  return true;
}

/** Which kind of account this instance may sign in: public shows user accounts, admin shows staff accounts, all (plain `npm run dev`) shows both. */
export function devLoginSurface(mode: AppMode): { users: boolean; staff: boolean } {
  return { users: mode !== "admin", staff: mode !== "public" };
}
