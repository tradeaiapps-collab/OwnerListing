import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))));

/** scrypt with N = 2^15, r = 8, p = 3: one of the OWASP minimum settings, 32 MiB per hash. */
const LOG_N = 15, R = 8, P = 3, KEY_LEN = 32;
const opts = (logN: number, r: number, p: number): ScryptOptions => ({ N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 });

/** Stored as `scrypt$logN$r$p$salt$key` (base64url), so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, opts(LOG_N, R, P));
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Fixed hash used when no account matches, so a wrong email takes as long as a wrong password. */
const DUMMY = "scrypt$15$8$3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** True only when `stored` is a well-formed hash of `password`. A missing or malformed hash still costs one scrypt run, then fails. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (typeof stored === "string" ? stored : DUMMY).split("$");
  const ok = parts.length === 6 && parts[0] === "scrypt";
  const [logN, r, p] = ok ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : [LOG_N, R, P];
  const sane = ok && Number.isInteger(logN) && logN >= 14 && logN <= 20 && Number.isInteger(r) && r >= 8 && r <= 16 && Number.isInteger(p) && p >= 1 && p <= 4;
  const salt = Buffer.from(sane ? parts[4]! : "AAAAAAAAAAAAAAAAAAAAAA", "base64url");
  const want = Buffer.from(sane ? parts[5]! : "", "base64url");
  const got = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, sane ? opts(logN, r, p) : opts(LOG_N, R, P));
  return sane && typeof stored === "string" && want.length === got.length && timingSafeEqual(want, got);
}
