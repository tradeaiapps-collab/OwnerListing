export const JSON_HEADERS = { "content-type": "application/json" } as const;

export async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}
export const send = (method: string, data?: unknown): RequestInit => ({ method, headers: JSON_HEADERS, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });

export const dayKey = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
export const timeText = (iso: string, tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
export const dateText = (iso: string, tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
export const whenText = (iso: string, tz: string) => `${dateText(iso, tz)}, ${timeText(iso, tz)}`;
export const tzName = (tz: string) => tz.split("/")[1]?.replace("_", " ") ?? tz;
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
/** The visible label of a booking status. */
export const STATUS_LABEL: Record<string, string> = { booked: "Booked", rescheduled: "Rescheduled", cancelled: "Cancelled", completed: "Completed", no_show: "No-show" };
