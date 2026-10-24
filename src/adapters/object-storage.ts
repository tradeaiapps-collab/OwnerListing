/** Where uploaded file bytes live. Only the key and the SHA-256 are stored in the database, never the bytes or the filename. */
export interface ObjectStoragePort {
  /** False until a real provider is configured. Uploads are refused while false. */
  readonly configured: boolean;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** Provider choice is still open (see PROJECT_STATUS.md). Until one is wired in, nothing can be stored. */
export function createUnconfiguredStorage(): ObjectStoragePort {
  return { configured: false, async put() { throw new Error("File storage is not configured."); } };
}

/** Add a real provider here (private bucket, encrypted at rest). Any unknown or missing setting fails closed. */
export function objectStorageFromEnv(_env: Readonly<Record<string, string | undefined>>): ObjectStoragePort {
  return createUnconfiguredStorage();
}
