export interface Synthesised { audio: Buffer; contentType: string }
export type Synthesiser = (text: string) => Promise<Synthesised>;

/** Calls the self-hosted text-to-speech service (POST {"text"} -> audio bytes). No outside AI account is used or required. */
export function httpSynthesiser(url: string, apiKey?: string): Synthesiser {
  return async text => {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ text, voice: "elena" }), signal: AbortSignal.timeout(15_000)
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return { audio: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") ?? "audio/mpeg" };
  };
}

/** Small LRU with a TTL; used for recent answer text (so /voice/<id> can find it) and for synthesised audio. */
export class TtlCache<V> {
  private m = new Map<string, { v: V; at: number; size: number }>();
  private bytes = 0;
  private maxEntries: number; private ttlMs: number; private maxBytes: number; private now: () => number;
  constructor(maxEntries: number, ttlMs: number, maxBytes = Infinity, now: () => number = () => Date.now()) {
    this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.maxBytes = maxBytes; this.now = now;
  }
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) { this.delete(k); return undefined; }
    this.m.delete(k); this.m.set(k, e);
    return e.v;
  }
  set(k: string, v: V, size = 1) {
    this.delete(k);
    this.m.set(k, { v, at: this.now(), size }); this.bytes += size;
    while (this.m.size > this.maxEntries || this.bytes > this.maxBytes) { const first = this.m.keys().next().value; if (first === undefined) break; this.delete(first); }
  }
  private delete(k: string) { const e = this.m.get(k); if (e) { this.bytes -= e.size; this.m.delete(k); } }
}
