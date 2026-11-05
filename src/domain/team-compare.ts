import { bucketLabel } from "./admin-analytics";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Staff view of teams: which teams are performing best and how each is trending. Counts for everyone with the sales report permission;
 * accepted-offer value and commission only with the financial report permission. Teams are agencies, not people, so names are shown in full.
 * Small samples are never ranked or flagged. Elena only suggests; nothing here changes data.
 */

export const MIN_TEAM_OFFERS = 3;
export const MIN_TEAM_ENQUIRIES = 20;
/** Teams drawn as lines on the trend chart. */
export const TREND_TEAMS = 3;

export interface TeamCounts { enquiries: number; offers: number; accepted: number; acceptedCents: number; commissionCents: number }
export interface TeamFact {
  id: string; name: string; kind: string; members: number; activeListings: number; overdueTasks: number;
  current: TeamCounts; previous: TeamCounts;
}
/** Accepted offers for one team in one bucket (a bucket start date). */
export interface TeamSeriesFact { teamId: string; bucket: string; accepted: number; cents: number }

export interface Trend { current: number; previous: number; changePct?: number }
export interface TeamRow {
  id: string; name: string; kind: string; members: number; activeListings: number; rank?: number;
  enquiries: Trend; offers: Trend; sold: Trend; offersPer100Enquiries?: number; overdueTasks: number; note: string;
  /** Present only with the financial report permission. */
  soldCents?: Trend; commissionCents?: number;
}
export interface TeamAlert { id: string; severity: "high" | "medium"; subject: string; message: string }
export interface TeamSeries { key: string; label: string; values: number[]; total: number }
export interface TeamComparison {
  rows: TeamRow[]; alerts: TeamAlert[]; note?: string; showMoney: boolean;
  trends?: { labels: string[]; sold: TeamSeries[]; soldCents?: TeamSeries[] };
}

const trend = (current: number, previous: number): Trend => ({ current, previous, ...(previous > 0 ? { changePct: Math.round(((current - previous) / previous) * 100) } : {}) });
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith("y") ? `${w.slice(0, -1)}ies` : `${w}s`}`;

export function buildTeamComparison(
  actor: StaffActor, facts: readonly TeamFact[], series: { buckets: readonly string[]; bucket: "day" | "week" | "month"; rows: readonly TeamSeriesFact[] } | undefined,
  opts: { money?: boolean } = {}
): TeamComparison {
  const showMoney = (opts.money ?? true) && staffCan(actor, "report.financial");
  const totalEnq = facts.reduce((s, t) => s + t.current.enquiries, 0), totalOffers = facts.reduce((s, t) => s + t.current.offers, 0);
  const platformFunnel = totalEnq >= MIN_TEAM_ENQUIRIES ? Math.round((totalOffers / totalEnq) * 100) : undefined;
  const alerts: TeamAlert[] = [];

  const rows: TeamRow[] = facts.map(t => {
    const c = t.current, p = t.previous, notes: string[] = [];
    const funnel = c.enquiries > 0 ? Math.round((c.offers / c.enquiries) * 100) : undefined;
    if (t.activeListings >= 3 && c.enquiries === 0) {
      notes.push("live listings, no enquiries");
      alerts.push({ id: `team-quiet-${t.id}`, severity: "high", subject: t.name, message: `${t.name}: ${plural(t.activeListings, "active listing")} and no enquiries this period.` });
    }
    if (p.accepted >= MIN_TEAM_OFFERS && c.accepted * 10 <= p.accepted * 5) {
      const drop = Math.round((1 - c.accepted / p.accepted) * 100);
      notes.push(`accepted offers down ${drop}%`);
      alerts.push({ id: `team-sales-${t.id}`, severity: drop >= 75 ? "high" : "medium", subject: t.name, message: `${t.name}: accepted offers fell ${drop}% (${p.accepted} to ${c.accepted}) against the previous period.` });
    }
    if (platformFunnel !== undefined && c.enquiries >= 5 && funnel !== undefined && funnel * 2 <= platformFunnel) {
      notes.push("few enquiries turn into offers");
      alerts.push({ id: `team-conv-${t.id}`, severity: "medium", subject: t.name, message: `${t.name}: ${plural(c.enquiries, "enquiry")} but ${plural(c.offers, "offer")} (${funnel}% of enquiries) against ${platformFunnel}% across teams.` });
    }
    if (t.overdueTasks >= 5) {
      notes.push(`${t.overdueTasks} overdue tasks`);
      alerts.push({ id: `team-tasks-${t.id}`, severity: "medium", subject: t.name, message: `${t.name}: ${plural(t.overdueTasks, "task")} past their due date.` });
    }
    return {
      id: t.id, name: t.name, kind: t.kind, members: t.members, activeListings: t.activeListings,
      enquiries: trend(c.enquiries, p.enquiries), offers: trend(c.offers, p.offers), sold: trend(c.accepted, p.accepted),
      ...(funnel !== undefined ? { offersPer100Enquiries: funnel } : {}), overdueTasks: t.overdueTasks, note: notes.join("; "),
      ...(showMoney ? { soldCents: trend(c.acceptedCents, p.acceptedCents), commissionCents: c.commissionCents } : {})
    };
  });

  // Ranked on accepted offers (then offers) only for teams with enough offers to mean something; the rest follow, busiest first.
  const rankable = rows.filter(r => r.offers.current >= MIN_TEAM_OFFERS)
    .sort((a, b) => b.sold.current - a.sold.current || (b.soldCents?.current ?? 0) - (a.soldCents?.current ?? 0) || b.offers.current - a.offers.current || a.name.localeCompare(b.name));
  rankable.forEach((r, n) => { r.rank = n + 1; });
  const rest = rows.filter(r => r.rank === undefined).sort((a, b) => b.enquiries.current - a.enquiries.current || a.name.localeCompare(b.name));
  const ordered = [...rankable, ...rest];

  const order = { high: 0, medium: 1 } as const;
  alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  const note = rankable.length < 3 ? `Fewer than 3 teams have ${MIN_TEAM_OFFERS}+ offers this period, so ranks are a rough guide.` : undefined;

  let trends: TeamComparison["trends"];
  if (series) {
    const top = ordered.slice(0, TREND_TEAMS);
    const at = new Map(series.buckets.map((b, n) => [b, n]));
    const build = (pick: (r: TeamSeriesFact) => number): TeamSeries[] => top.map(t => {
      const values = series.buckets.map(() => 0);
      for (const r of series.rows) if (r.teamId === t.id) { const n = at.get(r.bucket); if (n !== undefined) values[n]! += pick(r); }
      return { key: t.id, label: t.name, values, total: values.reduce((s, v) => s + v, 0) };
    });
    trends = { labels: series.buckets.map(b => bucketLabel(b, series.bucket)), sold: build(r => r.accepted), ...(showMoney ? { soldCents: build(r => r.cents) } : {}) };
  }
  return { rows: ordered, alerts, showMoney, ...(note ? { note } : {}), ...(trends ? { trends } : {}) };
}
