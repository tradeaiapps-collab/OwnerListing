import type { JobPoll, VideoImage, VideoProvider } from "../domain/listing-video";

// Hedra v3 adapter (plain fetch so tests inject it). Model kling-v3 with a start and an end photo, Hedra's own defaults otherwise.
// The key comes from HEDRA_API_KEY; without it the provider reports not configured and nothing is submitted.

type Env = Readonly<Record<string, string | undefined>>;
export const HEDRA_API = "https://api.hedra.com/v3";
const MODEL = "kling-v3";
const DURATION_MS = 10_000;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export function hedraVideoFromEnv(env: Env = process.env, fetchImpl: typeof fetch = fetch): VideoProvider {
  const key = env["HEDRA_API_KEY"] ?? "";
  const webhook = /^https:\/\/[^\s]+$/.test(env["HEDRA_WEBHOOK_URL"] ?? "") ? env["HEDRA_WEBHOOK_URL"] : undefined;
  const headers = (extra: Record<string, string> = {}) => ({ "x-api-key": key, ...extra });

  async function json(res: Response): Promise<Record<string, unknown>> {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = body["error"] as { message?: unknown } | undefined;
      throw new Error(`Hedra ${res.status}: ${typeof e?.message === "string" ? e.message : "request failed"}`);
    }
    return body;
  }
  async function upload(img: VideoImage): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([img.bytes as BlobPart], { type: img.contentType }), "photo");
    const r = await json(await fetchImpl(`${HEDRA_API}/files`, { method: "POST", headers: headers(), body: form, signal: AbortSignal.timeout(60_000) }));
    if (typeof r["url"] !== "string") throw new Error("Hedra upload returned no url.");
    return r["url"];
  }

  return {
    configured: key.length >= 8,
    async submit({ images, prompt, idempotencyKey }) {
      if (images.length < 2) throw new Error("Two photos are needed.");
      const urls = await Promise.all(images.slice(0, 2).map(upload));
      const input = {
        prompt, aspect_ratio: "16:9", duration_ms: DURATION_MS, generate_audio: false,
        start_image: { source: "url", url: urls[0] }, end_image: { source: "url", url: urls[1] }
      };
      const r = await json(await fetchImpl(`${HEDRA_API}/models/${MODEL}`, {
        method: "POST", headers: headers({ "content-type": "application/json", "idempotency-key": idempotencyKey }),
        body: JSON.stringify({ input, ...(webhook ? { webhook } : {}) }), signal: AbortSignal.timeout(30_000)
      }));
      if (typeof r["job_id"] !== "string") throw new Error("Hedra returned no job id.");
      return { jobId: r["job_id"] };
    },
    async poll(jobId): Promise<JobPoll> {
      const r = await json(await fetchImpl(`${HEDRA_API}/jobs/${encodeURIComponent(jobId)}`, { headers: headers(), signal: AbortSignal.timeout(30_000) }));
      if (r["status"] === "FAILED") {
        const e = r["error"] as { message?: unknown } | null | undefined;
        return { state: "failed", message: typeof e?.message === "string" ? e.message.slice(0, 300) : "Hedra could not make the video." };
      }
      if (r["status"] !== "COMPLETED") return { state: "running" };
      const out = (Array.isArray(r["outputs"]) ? r["outputs"] : [])[0] as { url?: unknown; content_type?: unknown; status?: unknown } | undefined;
      if (!out || out.status === "FAILED" || typeof out.url !== "string" || !out.url.startsWith("https://")) return { state: "failed", message: "Hedra finished without a video." };
      return { state: "ready", downloadUrl: out.url, contentType: typeof out.content_type === "string" ? out.content_type : "video/mp4" };
    },
    async download(url) {
      if (!url.startsWith("https://")) throw new Error("Refusing a non-https download.");
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_DOWNLOAD_BYTES) throw new Error("The video is too large.");
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "video/mp4" };
    }
  };
}
