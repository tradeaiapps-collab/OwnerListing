import { mkdtemp, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localDevStorageDir } from "../src/adapters/local-disk-core.mjs";
import { malwareScannerFromEnv } from "../src/adapters/malware-scan";
import { objectStorageFromEnv } from "../src/adapters/object-storage";

const root = path.join(__dirname, "..");
const DIR = path.join(tmpdir(), "ol-local-storage");

describe("local test kit storage (LOCAL_STORAGE_DIR)", () => {
  it("is used only outside production, off Vercel, with an absolute folder", () => {
    expect(localDevStorageDir({ LOCAL_STORAGE_DIR: DIR })).toBe(DIR);
    expect(localDevStorageDir({ LOCAL_STORAGE_DIR: DIR, NODE_ENV: "development" })).toBe(DIR);
    expect(localDevStorageDir({ LOCAL_STORAGE_DIR: DIR, NODE_ENV: "production" })).toBeNull();
    expect(localDevStorageDir({ LOCAL_STORAGE_DIR: DIR, VERCEL: "1" })).toBeNull();
    expect(localDevStorageDir({ LOCAL_STORAGE_DIR: "relative/dir" })).toBeNull();
    expect(localDevStorageDir({ LOCAL_STORAGE_DIR: "" })).toBeNull();
    expect(localDevStorageDir({})).toBeNull();
    expect(objectStorageFromEnv({ LOCAL_STORAGE_DIR: DIR, STORAGE_DRIVER: "" }).configured).toBe(true);
    expect(objectStorageFromEnv({ LOCAL_STORAGE_DIR: DIR, NODE_ENV: "production" }).configured).toBe(false);
    expect(objectStorageFromEnv({ LOCAL_STORAGE_DIR: DIR, VERCEL: "1" }).configured).toBe(false);
    // A configured real driver wins over the kit folder.
    expect(objectStorageFromEnv({ LOCAL_STORAGE_DIR: DIR, STORAGE_DRIVER: "s3" }).configured).toBe(false);
  });

  it("writes owner-only files that cannot be overwritten, and refuses keys that leave the folder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ol-kit-"));
    const s = objectStorageFromEnv({ LOCAL_STORAGE_DIR: dir });
    const key = "listings/00000000-0000-4000-8000-000000000001/abc";
    await s.put(key, Uint8Array.from([1, 2, 3]), "image/png");
    expect(Array.from(await s.get(key))).toEqual([1, 2, 3]);
    expect(Array.from(await readFile(path.join(dir, key)))).toEqual([1, 2, 3]);
    if (process.platform !== "win32") expect((await stat(path.join(dir, key))).mode & 0o777).toBe(0o600);
    await expect(s.put(key, Uint8Array.from([9]), "image/png")).rejects.toThrow();
    for (const bad of ["../x/y", "listings/../../etc", "listings/a/b/c", "other/a/b"]) await expect(s.get(bad)).rejects.toThrow(/Invalid storage key/);
    await expect(s.remove!(key)).rejects.toThrow(/Only identity images/);
  });
});

describe("local-noop malware scanner", () => {
  it("only under the same dev-only guard, and a real clamd setting wins", async () => {
    const noop = malwareScannerFromEnv({ MALWARE_SCAN_DRIVER: "local-noop", LOCAL_STORAGE_DIR: DIR });
    expect(noop.configured).toBe(true);
    expect(await noop.scan(Uint8Array.from([1]))).toBe("clean");
    expect(malwareScannerFromEnv({ MALWARE_SCAN_DRIVER: "local-noop" }).configured).toBe(false);
    expect(malwareScannerFromEnv({ MALWARE_SCAN_DRIVER: "local-noop", LOCAL_STORAGE_DIR: DIR, NODE_ENV: "production" }).configured).toBe(false);
    expect(malwareScannerFromEnv({ MALWARE_SCAN_DRIVER: "local-noop", LOCAL_STORAGE_DIR: DIR, VERCEL: "1" }).configured).toBe(false);
    expect(malwareScannerFromEnv({ MALWARE_SCAN_DRIVER: "noop", LOCAL_STORAGE_DIR: DIR }).configured).toBe(false);
  });
});

describe("local kit scripts", () => {
  const sh = readFileSync(path.join(root, "scripts", "local-setup.sh"), "utf8");
  const ps = readFileSync(path.join(root, "scripts", "local-setup.ps1"), "utf8");
  it("write dummy Google keys, the storage folder and the noop scanner into .env.local when missing or empty", () => {
    for (const line of ["ensure_env GOOGLE_CLIENT_ID local-dummy", "ensure_env GOOGLE_CLIENT_SECRET local-dummy", "ensure_env LOCAL_STORAGE_DIR", "ensure_env MALWARE_SCAN_DRIVER local-noop"]) expect(sh).toContain(line);
    for (const line of ['Ensure-Env "GOOGLE_CLIENT_ID" "local-dummy"', 'Ensure-Env "GOOGLE_CLIENT_SECRET" "local-dummy"', 'Ensure-Env "LOCAL_STORAGE_DIR"', 'Ensure-Env "MALWARE_SCAN_DRIVER" "local-noop"']) expect(ps).toContain(line);
  });
  it("the seed writes demo photos through the shared local-disk code, behind the same guard", () => {
    const seed = readFileSync(path.join(root, "scripts", "seed-demo.mjs"), "utf8");
    expect(seed).toContain('from "../src/adapters/local-disk-core.mjs"');
    expect(seed).toMatch(/localDevStorageDir\(process\.env\)/);
    expect(seed).toMatch(/putLocalObject\(dir, key/);
  });
  it("the storage folder is git-ignored", () => {
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toMatch(/^\.local-storage\/$/m);
  });
});
