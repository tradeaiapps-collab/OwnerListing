import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { useAuth } from "./auth";
import { cachedLoad, createCache, createOutbox, sendOrQueue, type Cache, type KeyValueStore, type Outbox, type QueuedAction } from "./lib/offline";
import { shortDateTime } from "./lib/format";
import { useLoad } from "./use-load";
import { font, space, useColors } from "./ui/theme";

const kv: KeyValueStore = {
  get: k => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  remove: k => AsyncStorage.removeItem(k),
  keys: async () => [...(await AsyncStorage.getAllKeys())]
};

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface OfflineValue {
  cache: Cache;
  outbox: Outbox;
  /** Number of changes saved on this phone and not yet sent. */
  pending: number;
  /** Goes up each time queued changes were sent, so screens reload. */
  syncVersion: number;
  notice: string | null;
  clearNotice(): void;
  /** Runs the action now, or saves it for later when the phone has no connection. */
  act(a: Omit<QueuedAction, "id" | "createdAt">): Promise<"sent" | "queued">;
  flush(): Promise<void>;
}
const Ctx = createContext<OfflineValue | null>(null);

/** Saved copies, the outbox and syncing, for the signed-in person. Sent again when the app opens, comes back to the front, or every 30 seconds while changes are waiting. */
export function OfflineProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const { api } = useAuth();
  const [pending, setPending] = useState(0);
  const [syncVersion, setSyncVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const cache = useMemo(() => createCache(kv, userId ?? "none"), [userId]);
  const outbox = useMemo(() => createOutbox(kv, userId ?? "none", newId), [userId]);
  const hadUser = useRef(false);

  useEffect(() => {
    if (userId) hadUser.current = true;
    else if (hadUser.current) { hadUser.current = false; void cache.clearAll(); } // signed out: no saved copies stay on the phone
  }, [userId, cache]);

  const flush = useCallback(async () => {
    if (!userId) return;
    const r = await outbox.flush(api).catch(() => null);
    if (!r) return;
    setPending(r.remaining);
    if (r.sent.length) setSyncVersion(v => v + 1);
    if (r.rejected.length) setNotice(`${r.rejected.length === 1 ? "A change" : `${r.rejected.length} changes`} made offline could not be saved: ${r.rejected[0]!.reason}`);
  }, [api, outbox, userId]);

  useEffect(() => {
    if (!userId) return;
    void outbox.list().then(l => setPending(l.length));
    void flush();
    const sub = AppState.addEventListener("change", s => { if (s === "active") void flush(); });
    return () => sub.remove();
  }, [userId, outbox, flush]);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void flush(), 30_000);
    return () => clearInterval(t);
  }, [pending, flush]);

  const value = useMemo<OfflineValue>(() => ({
    cache, outbox, pending, syncVersion, notice, clearNotice: () => setNotice(null), flush,
    async act(a) {
      const r = await sendOrQueue(api, outbox, a);
      if (r === "queued") setPending((await outbox.list()).length);
      return r;
    }
  }), [api, cache, outbox, pending, syncVersion, notice, flush]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOffline(): OfflineValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOffline must be used inside OfflineProvider.");
  return v;
}

/** Like useLoad, but keeps the last good answer on the phone and falls back to it with no connection. */
export function useCachedLoad<T>(key: string, load: () => Promise<T>, deps: unknown[] = []) {
  const { cache, syncVersion } = useOffline();
  const r = useLoad(() => cachedLoad(cache, key, load), [cache, key, syncVersion, ...deps]);
  return { ...r, data: r.data?.data ?? null, stale: r.data?.stale ?? false, savedAt: r.data?.savedAt ?? null };
}

/** Shown at the top of a screen: offline copy, changes waiting to send, refused changes. */
export function SyncBanner({ stale, savedAt }: { stale?: boolean; savedAt?: string | null }) {
  const { pending, notice, clearNotice } = useOffline();
  const c = useColors();
  const lines: { text: string; danger?: boolean; onPress?: () => void }[] = [];
  if (stale) lines.push({ text: `Offline. Showing the copy saved ${savedAt ? shortDateTime(savedAt) : "earlier"}.` });
  if (pending) lines.push({ text: `${pending} ${pending === 1 ? "change is" : "changes are"} waiting to send. They send when you are back online.` });
  if (notice) lines.push({ text: notice, danger: true, onPress: clearNotice });
  if (!lines.length) return null;
  return (
    <View style={[s.wrap, { backgroundColor: c.unread, borderColor: c.border }]} accessibilityRole="alert">
      {lines.map(l => <Text key={l.text} onPress={l.onPress} style={{ color: l.danger ? c.danger : c.text, fontSize: font.small }}>{l.text}{l.onPress ? " (tap to dismiss)" : ""}</Text>)}
    </View>
  );
}
const s = StyleSheet.create({ wrap: { padding: space.md, borderBottomWidth: 1, gap: space.xs } });
