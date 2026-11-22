// Read-only health check of the production ClamAV server, using the same CLAMD_* env vars as the app.
// Usage: CLAMD_HOST=... CLAMD_PORT=3443 CLAMD_TLS_CA_B64=... CLAMD_TLS_CERT_B64=... CLAMD_TLS_KEY_B64=... npm run check:clamd
// Checks: (1) clamd answers PONG, (2) a harmless test string (EICAR) is reported as FOUND, (3) clean bytes are reported OK.
// Also run by `npm run smoke:prod` when CLAMD_HOST is set. Nothing is stored anywhere.
import net from "node:net";
import tls from "node:tls";

// The EICAR antivirus test string is harmless; it is split so this file is not flagged by antivirus on a PC.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const b64 = v => Buffer.from(v, "base64").toString("utf8");

function connect(env) {
  const host = env.CLAMD_HOST, port = Number(env.CLAMD_PORT);
  const t = [env.CLAMD_TLS_CA_B64, env.CLAMD_TLS_CERT_B64, env.CLAMD_TLS_KEY_B64];
  if (t.some(Boolean) && !t.every(Boolean)) throw new Error("Set all three CLAMD_TLS_*_B64 values or none.");
  return t.every(Boolean)
    ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ca: b64(t[0]), cert: b64(t[1]), key: b64(t[2]), minVersion: "TLSv1.2" })
    : net.connect({ host, port });
}

function ask(env, write) {
  return new Promise((resolve, reject) => {
    const chunks = []; let socket;
    try { socket = connect(env); } catch (e) { return reject(e); }
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error("timed out")); });
    socket.on("error", e => reject(new Error(e.code || e.message)));
    socket.on("data", d => chunks.push(d));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim()));
    socket.on(env.__tls ? "secureConnect" : "connect", () => write(socket));
  });
}
const instream = bytes => s => {
  s.write("zINSTREAM\0");
  const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length); s.write(len); s.write(bytes); s.write(Buffer.alloc(4));
};

export async function checkClamd(env = process.env) {
  const results = [];
  const run = async (name, fn, pass) => {
    try { const r = await fn(); results.push({ name, ok: pass(r), detail: r }); }
    catch (e) { results.push({ name, ok: false, detail: String(e.message || e) }); }
  };
  const e = { ...env, __tls: Boolean(env.CLAMD_TLS_CA_B64) };
  await run("clamd answers PING", () => ask(e, s => s.write("zPING\0")), r => r === "PONG");
  await run("EICAR test string is detected", () => ask(e, instream(Buffer.from(EICAR))), r => /^stream: .+ FOUND$/.test(r));
  await run("clean bytes pass", () => ask(e, instream(Buffer.from("hello clean file"))), r => r === "stream: OK");
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.CLAMD_HOST || !process.env.CLAMD_PORT) { console.error("CLAMD_HOST and CLAMD_PORT are required."); process.exit(2); }
  const res = await checkClamd();
  for (const r of res) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ok ? "" : r.detail}`);
  process.exit(res.every(r => r.ok) ? 0 : 1);
}
