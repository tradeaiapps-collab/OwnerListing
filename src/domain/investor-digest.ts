/** Weekly investor digest: pure rules (when one is due, how it reads). Nothing here touches the database. */
export const DIGEST_INTERVAL_MS = 7 * 24 * 3600_000;

export interface DigestUpdate { projectId: string; projectTitle: string; title: string; body: string; at: string }
export interface DigestAnswer { projectId: string; projectTitle: string; question: string; answer: string; by: "elena" | "owner"; at: string }

const MAX_PROJECTS = 6, MAX_PER_KIND = 3, TEXT_BUDGET = 1400;
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** Start of the window a digest covers: since the last one, or the past week for a first digest. */
export function windowStart(lastSentAt: string | null | undefined, now: string): string {
  const n = Date.parse(now), l = lastSentAt ? Date.parse(lastSentAt) : NaN;
  return new Date(Number.isFinite(l) ? l : n - DIGEST_INTERVAL_MS).toISOString();
}
export const isDue = (lastSentAt: string | null | undefined, now: string): boolean =>
  !lastSentAt || Date.parse(now) - Date.parse(lastSentAt) >= DIGEST_INTERVAL_MS;

/** Body for PUT: exactly { enabled: boolean }. */
export function parseInvestorDigestInput(body: unknown): { ok: true; enabled: boolean } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => k !== "enabled")) return { ok: false, message: "Unsupported field." };
  if (typeof b["enabled"] !== "boolean") return { ok: false, message: "enabled must be true or false." };
  return { ok: true, enabled: b["enabled"] };
}

/** The email, or null when the week had nothing new (nothing is sent then). Only text the investor may already see is passed in. */
export function buildDigest(updates: readonly DigestUpdate[], answers: readonly DigestAnswer[]): { title: string; text: string; updates: number; answers: number } | null {
  if (updates.length === 0 && answers.length === 0) return null;
  const projects = new Map<string, { title: string; updates: DigestUpdate[]; answers: DigestAnswer[] }>();
  const slot = (id: string, title: string) => { let p = projects.get(id); if (!p) { p = { title, updates: [], answers: [] }; projects.set(id, p); } return p; };
  for (const u of updates) slot(u.projectId, u.projectTitle).updates.push(u);
  for (const a of answers) slot(a.projectId, a.projectTitle).answers.push(a);
  const FOOTER = "Open each project for the full text. You can turn this weekly email off in Notifications, Preferences.";
  const blocks: string[] = [];
  for (const p of [...projects.values()].slice(0, MAX_PROJECTS)) {
    const lines = [clip(p.title, 80)];
    for (const u of p.updates.slice(0, MAX_PER_KIND)) lines.push(`  Update: ${clip(u.title, 80)}. ${clip(u.body, 160)}`);
    if (p.updates.length > MAX_PER_KIND) lines.push(`  and ${p.updates.length - MAX_PER_KIND} more update${p.updates.length - MAX_PER_KIND === 1 ? "" : "s"}`);
    for (const a of p.answers.slice(0, MAX_PER_KIND)) lines.push(`  You asked: ${clip(a.question, 100)}. ${a.by === "owner" ? "The owner replied" : "Elena answered"}: ${clip(a.answer, 180)}`);
    if (p.answers.length > MAX_PER_KIND) lines.push(`  and ${p.answers.length - MAX_PER_KIND} more answer${p.answers.length - MAX_PER_KIND === 1 ? "" : "s"}`);
    blocks.push(lines.join("\n"));
  }
  // Whole projects are added while they fit, so the footer (with the opt-out hint) is never cut off.
  const kept: string[] = [];
  let used = FOOTER.length + 40;
  for (const b of blocks) { if (used + b.length + 2 > TEXT_BUDGET && kept.length > 0) break; kept.push(b.length + used > TEXT_BUDGET ? clip(b, TEXT_BUDGET - used) : b); used += b.length + 2; }
  const more = projects.size - kept.length;
  const text = [...kept, ...(more > 0 ? [`and ${more} more project${more === 1 ? "" : "s"}`] : []), FOOTER].join("\n\n");
  const parts = [updates.length ? `${updates.length} new update${updates.length === 1 ? "" : "s"}` : "", answers.length ? `${answers.length} answered question${answers.length === 1 ? "" : "s"}` : ""].filter(Boolean);
  return { title: `Your weekly project update: ${parts.join(" and ")}`, text, updates: updates.length, answers: answers.length };
}
