// Plain JavaScript core of the local-disk object storage, shared by src/adapters/object-storage.ts and scripts/seed-demo.mjs
// (the seed script runs under plain Node, so it cannot import TypeScript). Types: local-disk-core.d.mts.
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Keys are made by the server: listings/<id>/<id>, id/<hex>/<hex>, investments/<hex>/<hex> or inspections/<id>/<id>. Anything else is refused. */
const KEY = /^(listings|id|investments|inspections|signing)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;
const ID_KEY = /^id\//;

/** Absolute file path for a key, or throws. A key can never climb out of the storage folder. */
export function resolveStorageKey(root, key) {
  if (!path.isAbsolute(root)) throw new Error("The storage folder must be an absolute path.");
  const base = path.resolve(root);
  if (typeof key !== "string" || !KEY.test(key)) throw new Error("Invalid storage key.");
  const full = path.resolve(base, key);
  if (!full.startsWith(base + path.sep)) throw new Error("Invalid storage key.");
  return full;
}

/** Writes a new object. Never overwrites (flag "wx"); folders 0700, files 0600. */
export async function putLocalObject(root, key, bytes) {
  const full = resolveStorageKey(root, key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, bytes, { flag: "wx", mode: 0o600 });
}

export async function getLocalObject(root, key) {
  return new Uint8Array(await readFile(resolveStorageKey(root, key)));
}

/** Only identity images (id/ keys) can be deleted; listing files never. A missing file counts as deleted. */
export async function removeLocalObject(root, key) {
  if (!ID_KEY.test(key)) throw new Error("Only identity images can be deleted.");
  await unlink(resolveStorageKey(root, key)).catch(e => { if (e.code !== "ENOENT") throw e; });
}

/**
 * Local test kit only: LOCAL_STORAGE_DIR is honoured when NODE_ENV is not "production", the app is not on Vercel,
 * and the folder is an absolute path. Returns the folder, or null.
 */
export function localDevStorageDir(env) {
  if (env.NODE_ENV === "production" || env.VERCEL) return null;
  const dir = env.LOCAL_STORAGE_DIR;
  return typeof dir === "string" && dir !== "" && path.isAbsolute(dir) ? dir : null;
}
