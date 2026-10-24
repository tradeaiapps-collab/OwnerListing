import { isIP } from "node:net";

/**
 * Outbound-connection guard for admin-supplied hosts (SMTP). Pure.
 * An address is "public" only when it is outside every loopback, private, link-local (incl. cloud metadata 169.254.169.254 and fd00:ec2::254),
 * shared, documentation, multicast, reserved and transition (NAT64, 6to4, Teredo) range. Unparseable input is not public (fails closed).
 */
// [first octet, second octet, prefix length]
const V4_BLOCKED: readonly (readonly [number, number, number])[] = [
  [0, 0, 8], [10, 0, 8], [100, 64, 10], [127, 0, 8], [169, 254, 16], [172, 16, 12], [192, 0, 24], [192, 168, 16],
  [198, 18, 15], [224, 0, 4], [240, 0, 4]
];
// Documentation and 6to4-relay /24 ranges
const V4_BLOCKED_24: readonly (readonly [number, number, number])[] = [[192, 0, 2], [198, 51, 100], [203, 0, 113], [192, 88, 99]];

function v4Parts(ip: string): number[] | undefined {
  const p = ip.split(".");
  if (p.length !== 4 || !p.every(x => /^\d{1,3}$/.test(x))) return undefined;
  const n = p.map(Number);
  return n.every(x => x <= 255) ? n : undefined;
}

function v4Public(n: number[]): boolean {
  const [a, b, c, d] = n as [number, number, number, number];
  const ip = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  for (const [x, y, bits] of V4_BLOCKED) {
    const net = ((x << 24) | (y << 16)) >>> 0;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    if ((ip & mask) === (net & mask)) return false;
  }
  for (const [x, y, z] of V4_BLOCKED_24) if (a === x && b === y && c === z) return false;
  return true;
}

/** Expands an IPv6 address to eight 16-bit groups (an embedded dotted IPv4 tail is converted), or undefined. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split("%")[0]!;
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":") + 1;
    const v4 = v4Parts(s.slice(cut));
    if (!v4) return undefined;
    s = `${s.slice(0, cut)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || !all.every(g => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map(g => parseInt(g, 16));
}

export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) { const n = v4Parts(ip); return n !== undefined && v4Public(n); }
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): judge the embedded IPv4 address. "::" and "::1" fall out here as 0.0.0.x.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return v4Public([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local (incl. fd00:ec2::254)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return false; // Teredo, documentation
  if (g0 === 0x2002) return false; // 6to4
  if (g0 === 0x64 && g1 === 0xff9b) return false; // NAT64
  return (g0 & 0xe000) === 0x2000; // only global unicast 2000::/3 is public
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".intranet", ".corp", ".home", ".home.arpa", ".private"];

/** Why a configured SMTP host is refused (name rules only; resolved addresses are checked at send time), or undefined. */
export function hostProblem(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIP(h) !== 0) return "Use a host name, not an IP address.";
  const labels = h.split(".");
  if (labels.length < 2 || !/^[a-z][a-z0-9-]*$/.test(labels[labels.length - 1]!)) return "Enter a full public host name such as smtp.example.com.";
  if (h === "localhost" || BLOCKED_SUFFIXES.some(s => h.endsWith(s))) return "Internal host names are not allowed.";
  return undefined;
}

/** Ports an SMTP server is expected on: 25, 465 (implicit TLS), 587 (submission), 2525 (alternate submission). */
export const SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];
