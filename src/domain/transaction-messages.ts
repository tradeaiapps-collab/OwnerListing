// Pure rules for the sale message thread. No database here.

export const ROLES = ["buyer", "seller", "agent"] as const;
export type Role = (typeof ROLES)[number];
export const MAX_BODY = 5000;
export const MAX_PER_MINUTE = 20;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The roles named with @buyer, @seller or @agent, in order, once each. */
export function mentionedRoles(body: string): Role[] {
  const found = new Set<Role>();
  for (const m of body.matchAll(/(^|[^\w@])@(buyer|seller|agent)\b/gi)) found.add(m[2]!.toLowerCase() as Role);
  return ROLES.filter(r => found.has(r));
}

export interface SendInput { body: string; replyToId: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function parseSend(raw: unknown): Result<SendInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send a message." };
  const b = raw as Record<string, unknown>;
  if (typeof b["body"] !== "string") return { ok: false, error: "Write a message first." };
  const body = b["body"].replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "Write a message first." };
  if (body.length > MAX_BODY) return { ok: false, error: `Keep messages under ${MAX_BODY} characters.` };
  const replyToId = b["replyToId"] == null ? null : b["replyToId"];
  if (replyToId !== null && !isUuid(replyToId)) return { ok: false, error: "That reply is not valid." };
  return { ok: true, value: { body, replyToId } };
}

export type ThreadAction = { action: "read" } | { action: "mute"; muted: boolean } | { action: "archive"; archived: boolean };

export function parseAction(raw: unknown): Result<ThreadAction | { action: "send"; send: SendInput }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send an action." };
  const b = raw as Record<string, unknown>;
  switch (b["action"]) {
    case "read": return { ok: true, value: { action: "read" } };
    case "mute": return typeof b["muted"] === "boolean" ? { ok: true, value: { action: "mute", muted: b["muted"] } } : { ok: false, error: "Say whether to mute." };
    case "archive": return typeof b["archived"] === "boolean" ? { ok: true, value: { action: "archive", archived: b["archived"] } } : { ok: false, error: "Say whether to archive." };
    case undefined: case "send": { const s = parseSend(b); return s.ok ? { ok: true, value: { action: "send", send: s.value } } : s; }
    default: return { ok: false, error: "Unknown action." };
  }
}

export const threadTitle = (address: string, buyerName: string) => `${address} - Offer from ${buyerName}`;
export const snippet = (body: string, max = 90) => { const one = body.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };

export const STAGE_NOTE = (from: string, to: string) => `Settlement stage advanced: ${from} → ${to}`;

// ---- Staff channels ----------------------------------------------------------------------------------------------------------

export const CHANNELS = ["general", "inspections", "disputes", "finance", "management"] as const;
export type Channel = (typeof CHANNELS)[number];
/** Who may see a channel: any staff for #general, otherwise a staff member holding at least one of the listed permissions. */
export const CHANNEL_ACCESS: Record<Channel, { label: string; blurb: string; anyOf: readonly string[] | null }> = {
  general: { label: "#general", blurb: "Team-wide updates", anyOf: null },
  inspections: { label: "#inspections", blurb: "Inspection marketplace and inspectors", anyOf: ["case.manage", "listing.moderate"] },
  disputes: { label: "#disputes", blurb: "Disputes and admin cases", anyOf: ["case.manage"] },
  finance: { label: "#finance", blurb: "Payments and reconciliation", anyOf: ["billing.manage"] },
  management: { label: "#management", blurb: "Staff management and operations", anyOf: ["staff.manage", "report.operations"] }
};
export const isChannel = (v: unknown): v is Channel => typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
export const mayUseChannel = (c: Channel, permissions: readonly string[]): boolean => { const a = CHANNEL_ACCESS[c].anyOf; return a === null || a.some(p => permissions.includes(p)); };
