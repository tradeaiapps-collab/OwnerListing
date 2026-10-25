import path from "node:path";
import { getLocalObject, localDevStorageDir, putLocalObject, removeLocalObject } from "./local-disk-core.mjs";

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

/**
 * Stores objects as files under one absolute folder. For development, staging and single-server installs; no external account.
 * put never overwrites (flag "wx"), files are owner-only (0600), and only identity images (id/ keys) can be deleted.
 * Keys are checked against a fixed pattern so they can never leave the folder (see local-disk-core.mjs).
 * Bytes are NOT encrypted at rest here: use an encrypted volume. Refused in production unless STORAGE_LOCAL_ALLOW_PRODUCTION=1.
 */
export function createLocalDiskStorage(root: string): ObjectStoragePort {
  if (!path.isAbsolute(root)) throw new Error("STORAGE_LOCAL_DIR must be an absolute path.");
  const base = path.resolve(root);
  return {
    configured: true,
    async put(key, bytes) { await putLocalObject(base, key, bytes); },
    async get(key) { return getLocalObject(base, key); },
    async remove(key) { await removeLocalObject(base, key); }
  };
}

/** Any unknown or missing setting fails closed (unconfigured, uploads answer 503). */
export function objectStorageFromEnv(env: Readonly<Record<string, string | undefined>>): ObjectStoragePort {
  // Local test kit: LOCAL_STORAGE_DIR, only outside production and never on Vercel (see localDevStorageDir).
  const devDir = localDevStorageDir(env);
  if (devDir && !env.STORAGE_DRIVER) return createLocalDiskStorage(devDir);
  if (env.STORAGE_DRIVER !== "local-disk") return createUnconfiguredStorage();
  if (env.NODE_ENV === "production" && env.STORAGE_LOCAL_ALLOW_PRODUCTION !== "1") return createUnconfiguredStorage();
  const dir = env.STORAGE_LOCAL_DIR;
  if (!dir || !path.isAbsolute(dir)) return createUnconfiguredStorage();
  return createLocalDiskStorage(dir);
}
