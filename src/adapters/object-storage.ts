import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where uploaded file bytes live. Only the key and the SHA-256 are stored in the database, never the bytes or the filename. */
export interface ObjectStoragePort {
  /** False until a real provider is configured. Uploads are refused while false. */
  readonly configured: boolean;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Reads an object back. Callers must have checked access first; this port does not. Throws if the object cannot be read. */
  get(key: string): Promise<Uint8Array>;
  /**
   * Deletes an identity image (keys under id/ only, for the retention job). Listing files are never deletable, so any
   * other key is refused. An object that is already gone counts as deleted. Ports without it cannot hold ID images.
   */
  remove?(key: string): Promise<void>;
}

/** Provider choice is still open (see PROJECT_STATUS.md). Until one is wired in, nothing can be stored. */
export function createUnconfiguredStorage(): ObjectStoragePort {
  return {
    configured: false,
    async put() { throw new Error("File storage is not configured."); },
    async get() { throw new Error("File storage is not configured."); }
  };
}

/** Keys are made by the server: listings/<uuid>/<uuid> or id/<hex>/<hex>. Anything else is refused, so a key can never climb out of the storage folder. */
const KEY = /^(listings|id)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;
const ID_KEY = /^id\//;

/**
 * Stores objects as files under one absolute folder. For development, staging and single-server installs; no external account.
 * put never overwrites (flag "wx"), files are owner-only (0600), and only identity images (id/ keys) can be deleted.
 * Bytes are NOT encrypted at rest here: use an encrypted volume. Refused in production unless STORAGE_LOCAL_ALLOW_PRODUCTION=1.
 */
export function createLocalDiskStorage(root: string): ObjectStoragePort {
  if (!path.isAbsolute(root)) throw new Error("STORAGE_LOCAL_DIR must be an absolute path.");
  const base = path.resolve(root);
  const resolve = (key: string): string => {
    if (!KEY.test(key)) throw new Error("Invalid storage key.");
    const full = path.resolve(base, key);
    if (!full.startsWith(base + path.sep)) throw new Error("Invalid storage key.");
    return full;
  };
  return {
    configured: true,
    async put(key, bytes) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await writeFile(full, bytes, { flag: "wx", mode: 0o600 });
    },
    async get(key) {
      return new Uint8Array(await readFile(resolve(key)));
    },
    async remove(key) {
      if (!ID_KEY.test(key)) throw new Error("Only identity images can be deleted.");
      await unlink(resolve(key)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
    }
  };
}

/** Any unknown or missing setting fails closed (unconfigured, uploads answer 503). */
export function objectStorageFromEnv(env: Readonly<Record<string, string | undefined>>): ObjectStoragePort {
  if (env.STORAGE_DRIVER !== "local-disk") return createUnconfiguredStorage();
  if (env.NODE_ENV === "production" && env.STORAGE_LOCAL_ALLOW_PRODUCTION !== "1") return createUnconfiguredStorage();
  const dir = env.STORAGE_LOCAL_DIR;
  if (!dir || !path.isAbsolute(dir)) return createUnconfiguredStorage();
  return createLocalDiskStorage(dir);
}
