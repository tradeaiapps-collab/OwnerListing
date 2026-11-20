/**
 * The owner's daily "what needs you" list (pure). Items come from real open work (replies waiting for approval, buyer questions Elena
 * could not answer, offers, contractor jobs, inspections coming up, unfinished listings), each with one tap to act. Hiding or ranking here
 * is only convenience: every action URL still enforces ownership on the server.
 */
export type ItemKind = "offer" | "approval" | "question" | "job_time" | "job_blocked" | "inspection" | "listing_blocker";
export type TodayAction = { type: "post"; url: string; body: Record<string, string>; label: string } | { type: "link"; href: string; label: string };
export interface TodayItem {
  id: string; kind: ItemKind; title: string; detail: string;
  /** When it started waiting, ISO. Older items of the same urgency come first. */
  at: string;
  /** 1 needs you now, 2 needs you today, 3 can wait. */
  urgency: 1 | 2 | 3;
  action: TodayAction;
  /** A second, optional way in (read the thread, see the job). */
  more?: TodayAction;
}

export const MAX_ITEMS = 25;
export const DIGEST_HOUR = 7;

export function rank(items: readonly TodayItem[]): TodayItem[] {
  return [...items].sort((a, b) => a.urgency - b.urgency || a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(0, MAX_ITEMS);
}

export const KIND_LABEL: Record<ItemKind, string> = {
  offer: "Offer", approval: "Elena's reply", question: "Buyer question", job_time: "Contractor time", job_blocked: "Contractor job",
  inspection: "Inspection", listing_blocker: "Listing"
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The email: a short list, no buyer contact details, no addresses, no amounts. The dashboard has the detail. */
export function digestText(items: readonly TodayItem[]): { title: string; text: string } {
  const n = items.length;
  const lines = items.slice(0, 8).map(i => `• ${clip(i.title, 90)}`);
  const more = n > 8 ? `\n…and ${n - 8} more.` : "";
  return { title: n === 1 ? "1 thing needs you today" : `${n} things need you today`, text: `${lines.join("\n")}${more}\nOpen your dashboard to act on each one.` };
}

const localParts = (iso: string, timeZone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: `${p["year"]}-${p["month"]}-${p["day"]}`, hour: Number(p["hour"]) };
};
/** The local date to record, or undefined when it is too early today or the digest already went out for this local date. */
export function digestDay(lastSentOn: string | undefined, nowIso: string, timeZone: string): string | undefined {
  const { date, hour } = localParts(nowIso, timeZone);
  return hour >= DIGEST_HOUR && lastSentOn !== date ? date : undefined;
}
