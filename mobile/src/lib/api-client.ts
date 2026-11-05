/**
 * The app's only way to call the OwnerListing API. Pure TypeScript (no React Native imports) so it is tested in the main test run.
 * - Sends the access token as Authorization: Bearer.
 * - On a 401 it refreshes once and retries once. Concurrent calls share one refresh: a refresh token works only once, and the server
 *   signs the phone out if an already-used one comes back, so two refreshes in parallel would end the session.
 * - When the refresh is refused, the stored tokens are wiped and onSignedOut fires (the app shows the sign-in screen).
 */
export interface TokenPair { accessToken: string; refreshToken: string }

/** Where tokens live. In the app this is expo-secure-store (Keychain on iPhone, Keystore-backed on Android). */
export interface TokenStore {
  read(): Promise<TokenPair | null>;
  write(tokens: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

export interface FetchResponseLike { status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export interface SignInResult {
  user: { id: string; userType: "owner" | "agent" | "buyer" };
  mfa: { required: boolean; enrolled: boolean };
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
  /** Signs in with email and password and stores the tokens. */
  signIn(email: string, password: string, device: { label: string; platform: "android" | "ios" }): Promise<SignInResult>;
  /** Ends the session on the server (best effort) and wipes the stored tokens. */
  signOut(): Promise<void>;
}

const MAX_PATH = 2000;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/;

export function createApiClient(opts: { baseUrl: string; store: TokenStore; fetch: FetchLike; onSignedOut?: () => void }): ApiClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  if (!/^https:\/\/[^/]+$/.test(base) && !LOCAL_HTTP.test(base)) {
    throw new Error("The API address must be an https origin (plain http only for a computer on your own network).");
  }
  let refreshing: Promise<TokenPair | null> | null = null;

  const errorFrom = async (res: FetchResponseLike) => {
    const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    const nested = typeof body?.error === "object" && body.error !== null ? (body.error as { message?: unknown; code?: unknown }) : null;
    const message = typeof body?.error === "string" ? body.error : typeof nested?.message === "string" ? nested.message : `Request failed (${res.status}).`;
    const code = typeof body?.code === "string" ? body.code : typeof nested?.code === "string" ? nested.code : undefined;
    return new ApiError(res.status, message, code);
  };

  async function raw(method: string, path: string, body: unknown, token: string | null) {
    if (!path.startsWith("/api/") || path.length > MAX_PATH) throw new Error("Only API paths can be called.");
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = `Bearer ${token}`;
    return opts.fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  async function signedOut() {
    await opts.store.clear();
    opts.onSignedOut?.();
  }

  function refresh(stale: TokenPair): Promise<TokenPair | null> {
    refreshing ??= (async () => {
      try {
        const current = await opts.store.read();
        if (!current) return null;
        // Another call already refreshed while this one waited: use its tokens.
        if (current.refreshToken !== stale.refreshToken) return current;
        const res = await raw("POST", "/api/mobile/auth/refresh", { refreshToken: current.refreshToken }, null);
        if (res.status !== 200) {
          // 401: the session is over. Anything else (server down) keeps the tokens so a later call can refresh.
          if (res.status === 401) await signedOut();
          return null;
        }
        const next = (await res.json()) as TokenPair;
        const pair = { accessToken: next.accessToken, refreshToken: next.refreshToken };
        await opts.store.write(pair);
        return pair;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (refreshing) await refreshing;
    const tokens = await opts.store.read();
    let res = await raw(method, path, body, tokens?.accessToken ?? null);
    if (res.status === 401 && tokens) {
      const next = await refresh(tokens);
      if (!next) throw new ApiError(401, "Please sign in again.", "signed_out");
      res = await raw(method, path, body, next.accessToken);
    }
    if (res.status < 200 || res.status >= 300) throw await errorFrom(res);
    return (await res.json().catch(() => ({}))) as T;
  }

  return {
    get: path => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
    put: (path, body) => call("PUT", path, body ?? {}),
    del: (path, body) => call("DELETE", path, body),
    async signIn(email, password, device) {
      const res = await raw("POST", "/api/mobile/auth/login", { email, password, deviceLabel: device.label, platform: device.platform }, null);
      if (res.status !== 200) throw await errorFrom(res);
      const b = (await res.json()) as TokenPair & SignInResult;
      await opts.store.write({ accessToken: b.accessToken, refreshToken: b.refreshToken });
      return { user: b.user, mfa: b.mfa };
    },
    async signOut() {
      const tokens = await opts.store.read();
      if (tokens) await raw("POST", "/api/mobile/auth/logout", {}, tokens.accessToken).catch(() => undefined);
      await signedOut();
    }
  };
}
