import type { ReactNode } from "react";

export const JSON_HEADERS = { "content-type": "application/json" } as const;
export const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join("") || "?";
export const monthLabel = (ym: string) => new Intl.DateTimeFormat("en-AU", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`));
export const whenLabel = (iso: string, tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));

/** Read-only stars with a text alternative. */
export function Stars({ value, count }: { value: number | null; count?: number }): ReactNode {
  if (value === null) return <span className="ma-stars muted">No reviews yet</span>;
  return (
    <span className="ma-stars" role="img" aria-label={`Rated ${value} out of 5${count !== undefined ? ` from ${count} ${count === 1 ? "review" : "reviews"}` : ""}`}>
      {[1, 2, 3, 4, 5].map(n => <span key={n} aria-hidden="true" className={n <= Math.round(value) ? "on" : "off"}>★</span>)}
      <strong>{value.toFixed(1)}</strong>{count !== undefined && <span className="muted">({count})</span>}
    </span>
  );
}

export function Avatar({ name, photoUrl, large }: { name: string; photoUrl: string | null; large?: boolean }): ReactNode {
  const cls = `ma-avatar${large ? " lg" : ""}`;
  return photoUrl ? <img className={cls} src={photoUrl} alt="" width={large ? 88 : 56} height={large ? 88 : 56} referrerPolicy="no-referrer" loading="lazy" /> : <span className={cls} aria-hidden="true">{initials(name)}</span>;
}
