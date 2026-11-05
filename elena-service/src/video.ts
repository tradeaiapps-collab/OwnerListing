import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export const ANIMATIONS = ["idle", "talking", "presenting"] as const;
const TYPES = { mp4: "video/mp4", webm: "video/webm" } as const;

export function serveVideo(req: IncomingMessage, res: ServerResponse, dir: string, animation: string, format: string | null): boolean {
  if (!(ANIMATIONS as readonly string[]).includes(animation)) return false;
  // Explicit ?format wins; otherwise prefer webm only when the caller says it accepts it and not mp4.
  const accept = String(req.headers["accept"] ?? "");
  const fmt = format ?? (accept.includes("video/webm") && !accept.includes("video/mp4") ? "webm" : "mp4");
  if (fmt !== "mp4" && fmt !== "webm") return false;
  const file = path.join(dir, `elena-video-${animation}.${fmt}`);
  let st; try { st = statSync(file); } catch { return false; }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = { "content-type": TYPES[fmt], "cache-control": "public, max-age=86400", etag, "accept-ranges": "bytes" };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, base); res.end(); return true; }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers["range"] ?? ""));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start < 0) start = 0;
    if (start > end) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); res.end(); return true; }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") res.end(); else createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, "content-length": st.size });
  if (req.method === "HEAD") res.end(); else createReadStream(file).pipe(res);
  return true;
}
