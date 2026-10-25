export function resolveStorageKey(root: string, key: string): string;
export function putLocalObject(root: string, key: string, bytes: Uint8Array): Promise<void>;
export function getLocalObject(root: string, key: string): Promise<Uint8Array>;
export function removeLocalObject(root: string, key: string): Promise<void>;
export function localDevStorageDir(env: Readonly<Record<string, string | undefined>>): string | null;
