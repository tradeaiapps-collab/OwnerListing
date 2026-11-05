/**
 * Offline support for the phone app. Pure TypeScript (storage and network are passed in) so it is tested in the main test run.
 * - Cache: the last good answer for a read, shown (marked "saved copy") when the phone has no connection.
 * - Outbox: actions taken offline (mark an inspection complete, tick a checklist item, send a message), sent in order once back online.
 */
import { ApiError, type ApiClient } from "./api-client";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** True when the request never got an answer (no connection, timeout) or the server failed: worth trying again later. */
export const isRetryable = (e: unknown): boolean => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;
/** True only when the phone itself has no usable connection. */
export const isOffline = (e: unknown): boolean => !(e instanceof ApiError);

// ---------- cache ----------
export interface Cached<T> { data: T; savedAt: string }
const CACHE_PREFIX = "ol.cache.";

export function createCache(store: KeyValueStore, scope: string, now: () => Date = () => new Date()) {
  const k = (key: string) => `${CACHE_PREFIX}${scope}.${key}`;
  return {
    async read<T>(key: string): Promise<Cached<T> | null> {
      const raw = await store.get(k(key)).catch(() => null);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Partial<Cached<T>>;
        return typeof v.savedAt === "string" && "data" in v ? (v as Cached<T>) : null;
      } catch { return null; }
    },
    async write<T>(key: string, data: T): Promise<void> {
      await store.set(k(key), JSON.stringify({ data, savedAt: now().toISOString() })).catch(() => undefined);
    },
    /** Wipes every saved copy (all people on this phone). Called on sign-out. */
    async clearAll(): Promise<void> {
      const keys = await store.keys().catch(() => [] as string[]);
      await Promise.all(keys.filter(x => x.startsWith(CACHE_PREFIX)).map(x => store.remove(x).catch(() => undefined)));
    }
  };
}
export type Cache = ReturnType<typeof createCache>;

/** Fetches fresh data and saves it. With no connection, returns the saved copy (stale: true); with none saved, rethrows. */
export async function cachedLoad<T>(cache: Cache, key: string, fetcher: () => Promise<T>): Promise<{ data: T; stale: boolean; savedAt: string | null }> {
  try {
    const data = await fetcher();
    await cache.write(key, data);
    return { data, stale: false, savedAt: null };
  } catch (e) {
    if (!isOffline(e)) throw e;
    const hit = await cache.read<T>(key);
    if (!hit) throw e;
    return { data: hit.data, stale: true, savedAt: hit.savedAt };
  }
}

// ---------- outbox ----------
export type ActionKind = "inspection" | "settlement" | "message";
export interface QueuedAction { id: string; kind: ActionKind; path: string; body: unknown; label: string; createdAt: string }
export interface FlushResult { sent: string[]; rejected: { action: QueuedAction; reason: string }[]; remaining: number }

const OUTBOX_PREFIX = "ol.outbox.";
const MAX_QUEUED = 100;
/** Only these paths may be queued: an action stored on the phone can never reach anything else. */
const ALLOWED = [/^\/api\/agent\/open-inspections$/, /^\/api\/settlements\/[0-9a-f-]{36}$/i, /^\/api\/agent-appointments\/[0-9a-f-]{36}\/messages$/i];

/** One outbox per signed-in person, so a different person signing in on the same phone never sends someone else's queue. */
export function createOutbox(store: KeyValueStore, userId: string, newId: () => string, now: () => Date = () => new Date()) {
  const key = `${OUTBOX_PREFIX}${userId}`;
  const load = async (): Promise<QueuedAction[]> => {
    const raw = await store.get(key).catch(() => null);
    try { const v = raw ? (JSON.parse(raw) as unknown) : []; return Array.isArray(v) ? (v as QueuedAction[]) : []; } catch { return []; }
  };
  const save = (items: QueuedAction[]) => (items.length ? store.set(key, JSON.stringify(items)) : store.remove(key));
  let flushing: Promise<FlushResult> | null = null;

  return {
    list: load,
    async add(a: Omit<QueuedAction, "id" | "createdAt">): Promise<QueuedAction> {
      if (!ALLOWED.some(r => r.test(a.path))) throw new Error("This action cannot be saved for later.");
      const items = await load();
      if (items.length >= MAX_QUEUED) throw new Error("Too many unsent changes. Connect to the internet to send them first.");
      const item = { ...a, id: newId(), createdAt: now().toISOString() };
      await save([...items, item]);
      return item;
    },
    /** Sends queued actions oldest first. Stops at the first connection or server failure (order matters); a refused action is dropped and reported. Parallel calls share one run. */
    flush(api: Pick<ApiClient, "post">): Promise<FlushResult> {
      flushing ??= (async () => {
        const sent: string[] = [], rejected: FlushResult["rejected"] = [];
        let items = await load();
        while (items.length) {
          const next = items[0]!;
          try {
            await api.post(next.path, next.body);
            sent.push(next.id);
          } catch (e) {
            if (isRetryable(e)) break;
            rejected.push({ action: next, reason: e instanceof ApiError ? e.message : "Refused." });
          }
          items = items.slice(1);
          await save(items);
        }
        return { sent, rejected, remaining: items.length };
      })().finally(() => { flushing = null; });
      return flushing;
    }
  };
}
export type Outbox = ReturnType<typeof createOutbox>;

/** Runs an action now; if the phone is offline, queues it instead. Returns "sent" or "queued". Real refusals (4xx) still throw so the person sees why. */
export async function sendOrQueue(api: Pick<ApiClient, "post">, outbox: Outbox, a: Omit<QueuedAction, "id" | "createdAt">): Promise<"sent" | "queued"> {
  try {
    await api.post(a.path, a.body);
    return "sent";
  } catch (e) {
    if (!isOffline(e)) throw e;
    await outbox.add(a);
    return "queued";
  }
}
