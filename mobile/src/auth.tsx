import Constants from "expo-constants";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { createApiClient, type ApiClient, type TokenPair, type TokenStore } from "./lib/api-client";
import { registerForPush, unregisterPush } from "./push";

export type UserType = "owner" | "agent" | "buyer";
export interface User { id: string; userType: UserType }

/** loading: reading the keychain. mfa: password accepted, second step still needed on this phone. */
export type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "mfa"; enrolled: boolean }
  | { status: "signedIn"; user: User };

const KEY = "ownerlisting.tokens.v1";

/** Tokens live only in the Keychain (iPhone) or the Keystore-backed secure store (Android), readable only after first unlock. */
const secureStore: TokenStore = {
  async read() {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<TokenPair>;
      return typeof v.accessToken === "string" && typeof v.refreshToken === "string" ? { accessToken: v.accessToken, refreshToken: v.refreshToken } : null;
    } catch {
      return null;
    }
  },
  write: tokens => SecureStore.setItemAsync(KEY, JSON.stringify(tokens), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(KEY)
};

export const apiUrl = String((Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "http://localhost:3004");

interface AuthContextValue {
  state: AuthState;
  api: ApiClient;
  signIn(email: string, password: string): Promise<void>;
  /** Sends the second-step code (TOTP, SMS or recovery) for this phone. */
  verifyMfa(method: "totp" | "sms" | "recovery", code: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const pushDevice = useRef<string | null>(null);
  const api = useMemo(
    () => createApiClient({ baseUrl: apiUrl, store: secureStore, fetch: (url, init) => fetch(url, init), onSignedOut: () => setState({ status: "signedOut" }) }),
    []
  );

  /** Where the stored session stands now: signed in, waiting on the second step, or signed out. */
  const load = useCallback(async () => {
    if (!(await secureStore.read())) return setState({ status: "signedOut" });
    try {
      const me = await api.get<{ user: User | null; mfaPending?: { enrolled: boolean } }>("/api/auth/me");
      if (me.user) setState({ status: "signedIn", user: me.user });
      else if (me.mfaPending) setState({ status: "mfa", enrolled: me.mfaPending.enrolled });
      else setState({ status: "signedOut" });
    } catch {
      // Offline or the server is down: keep the tokens and show sign-in only when they were refused (onSignedOut).
      setState(s => (s.status === "loading" ? { status: "signedOut" } : s));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // Register this phone for push once fully signed in.
  useEffect(() => {
    if (state.status !== "signedIn") return;
    let cancelled = false;
    registerForPush(api).then(id => { if (!cancelled) pushDevice.current = id; }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, state.status]);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    api,
    async signIn(email, password) {
      const label = (Device.deviceName ?? Device.modelName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone")).slice(0, 80);
      const r = await api.signIn(email.trim(), password, { label, platform: Platform.OS === "ios" ? "ios" : "android" });
      setState(r.mfa.required ? { status: "mfa", enrolled: r.mfa.enrolled } : { status: "signedIn", user: r.user });
    },
    async verifyMfa(method, code) {
      await api.post("/api/auth/mfa/verify", { method, code: code.trim() });
      await load();
    },
    async signOut() {
      // Stop pushes to this phone before the session ends (the delete needs the session).
      await unregisterPush(api, pushDevice.current).catch(() => undefined);
      pushDevice.current = null;
      await api.signOut();
    }
  }), [api, load, state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside AuthProvider.");
  return v;
}

/** The signed-in user. Only for screens behind the signed-in layout. */
export function useUser(): User {
  const { state } = useAuth();
  if (state.status !== "signedIn") throw new Error("Not signed in.");
  return state.user;
}
