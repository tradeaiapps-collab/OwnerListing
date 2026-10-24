import net from "node:net";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClamdScanner, malwareScannerFromEnv } from "../src/adapters/malware-scan";
import { createLocalDiskStorage, objectStorageFromEnv } from "../src/adapters/object-storage";

const KEY = "listings/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";

describe("local disk storage", () => {
  it("stores and reads back bytes under the folder with owner-only permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ol-store-"));
    const s = createLocalDiskStorage(root);
    await s.put(KEY, new Uint8Array([1, 2, 3]), "image/png");
    expect([...(await s.get(KEY))]).toEqual([1, 2, 3]);
    expect((await stat(path.join(root, KEY))).mode & 0o777).toBe(0o600);
  });
  it("never overwrites an existing object", async () => {
    const s = createLocalDiskStorage(await mkdtemp(path.join(os.tmpdir(), "ol-store-")));
    await s.put(KEY, new Uint8Array([1]), "image/png");
    await expect(s.put(KEY, new Uint8Array([2]), "image/png")).rejects.toThrow();
    expect([...(await s.get(KEY))]).toEqual([1]);
  });
  it("refuses keys that are not server-made, including path tricks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ol-store-"));
    const s = createLocalDiskStorage(root);
    for (const bad of ["../x", "listings/../../etc/passwd", "listings/a/b/c", "/etc/passwd", "listings/a/b.png", "listings//b", "x/y/z", "listings/a\\b/c"]) {
      await expect(s.put(bad, new Uint8Array([1]), "image/png")).rejects.toThrow();
      await expect(s.get(bad)).rejects.toThrow();
    }
    expect(await readdir(root)).toEqual([]);
  });
  it("has no delete operation", () => {
    expect(Object.keys(createLocalDiskStorage("/tmp/x")).sort()).toEqual(["configured", "get", "put"]);
  });
  it("needs an absolute folder", () => {
    expect(() => createLocalDiskStorage("relative/dir")).toThrow();
  });
});

describe("objectStorageFromEnv fails closed", () => {
  it("is unconfigured without the driver, without an absolute folder, and in production without the opt-in", () => {
    expect(objectStorageFromEnv({}).configured).toBe(false);
    expect(objectStorageFromEnv({ STORAGE_DRIVER: "s3", STORAGE_LOCAL_DIR: "/data" }).configured).toBe(false);
    expect(objectStorageFromEnv({ STORAGE_DRIVER: "local-disk" }).configured).toBe(false);
    expect(objectStorageFromEnv({ STORAGE_DRIVER: "local-disk", STORAGE_LOCAL_DIR: "data" }).configured).toBe(false);
    expect(objectStorageFromEnv({ STORAGE_DRIVER: "local-disk", STORAGE_LOCAL_DIR: "/data", NODE_ENV: "production" }).configured).toBe(false);
  });
  it("is configured for local-disk with an absolute folder, and in production only with the opt-in", () => {
    expect(objectStorageFromEnv({ STORAGE_DRIVER: "local-disk", STORAGE_LOCAL_DIR: "/data" }).configured).toBe(true);
    expect(objectStorageFromEnv({ STORAGE_DRIVER: "local-disk", STORAGE_LOCAL_DIR: "/data", NODE_ENV: "production", STORAGE_LOCAL_ALLOW_PRODUCTION: "1" }).configured).toBe(true);
  });
});

/** A fake clamd: reads the INSTREAM framing, records the bytes, and answers with `reply` (or nothing / hangs). */
function fakeClamd(reply: string | null, opts: { hang?: boolean } = {}) {
  const received: Buffer[] = [];
  const server = net.createServer(sock => {
    let buf: Buffer = Buffer.alloc(0), started = false;
    sock.on("error", () => {});
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const cmd = Buffer.from("zINSTREAM\0");
        if (buf.length < cmd.length) return;
        expect(buf.subarray(0, cmd.length).equals(cmd)).toBe(true);
        buf = buf.subarray(cmd.length);
        started = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          if (opts.hang) return;
          if (reply !== null) sock.write(reply);
          sock.end();
          return;
        }
        if (buf.length < 4 + n) return;
        received.push(Buffer.from(buf.subarray(4, 4 + n)));
        buf = buf.subarray(4 + n);
      }
    });
  });
  return new Promise<{ port: number; received: Buffer[]; close: () => void }>(resolve =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() })));
}

describe("clamd scanner", () => {
  const closers: Array<() => void> = [];
  afterEach(() => { closers.splice(0).forEach(c => c()); });
  const run = async (reply: string | null, opts: { hang?: boolean; timeoutMs?: number } = {}) => {
    const srv = await fakeClamd(reply, opts);
    closers.push(srv.close);
    const scanner = createClamdScanner({ host: "127.0.0.1", port: srv.port, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    return { scanner, srv, bytes: new Uint8Array(150_000).fill(7) };
  };

  it("streams all bytes in framed chunks and returns clean only for 'stream: OK'", async () => {
    const { scanner, srv, bytes } = await run("stream: OK\0");
    expect(await scanner.scan(bytes)).toBe("clean");
    expect(Buffer.concat(srv.received).equals(Buffer.from(bytes))).toBe(true);
  });
  it("returns infected for a FOUND answer", async () => {
    const { scanner, bytes } = await run("stream: Eicar-Test-Signature FOUND\0");
    expect(await scanner.scan(bytes)).toBe("infected");
  });
  it("throws (fails closed) for errors, odd answers and empty answers", async () => {
    for (const reply of ["INSTREAM size limit exceeded. ERROR\0", "stream: OK and more\0", "OK", "", null]) {
      const { scanner, bytes } = await run(reply);
      await expect(scanner.scan(bytes)).rejects.toThrow();
    }
  });
  it("throws when clamd is unreachable", async () => {
    const srv = await fakeClamd("stream: OK\0");
    const port = srv.port;
    srv.close();
    await new Promise(r => setTimeout(r, 20));
    await expect(createClamdScanner({ host: "127.0.0.1", port }).scan(new Uint8Array([1]))).rejects.toThrow();
  });
  it("throws when clamd does not answer in time", async () => {
    const { scanner, bytes } = await run(null, { hang: true, timeoutMs: 100 });
    await expect(scanner.scan(bytes)).rejects.toThrow();
  });
  it("is unconfigured unless host and a valid port are set", () => {
    for (const env of [{}, { CLAMD_HOST: "h" }, { CLAMD_PORT: "3310" }, { CLAMD_HOST: "h", CLAMD_PORT: "0" }, { CLAMD_HOST: "h", CLAMD_PORT: "abc" }, { CLAMD_HOST: "h", CLAMD_PORT: "70000" }]) {
      expect(malwareScannerFromEnv(env).configured).toBe(false);
    }
    expect(malwareScannerFromEnv({ CLAMD_HOST: "h", CLAMD_PORT: "3310" }).configured).toBe(true);
  });
});
