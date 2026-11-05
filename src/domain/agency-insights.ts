/** One member's row on the team dashboard. Money fields are null where the viewer may not see them. */
export interface DashboardRow {
  userId: string;
  displayName: string;
  role: "manager" | "agent" | "staff";
  /** Active listing appointments held now. */
  activeListings: number;
  openTasks: number;
  overdueTasks: number;
  doneLast30: number;
  /** Member's share of commission recorded or approved but not yet marked paid. */
  owedCents: number | null;
  /** Member's share marked paid in the last 90 days. */
  paidCents: number | null;
  /** Member's share recorded in the last 90 days. */
  recordedCents: number | null;
  oldestUnpaidAt: string | null;
}

export interface TeamTotals {
  members: number; activeListings: number; openTasks: number; overdueTasks: number; doneLast30: number;
  owedCents: number | null; recordedCents: number | null;
}

export type InsightKind = "overdue_tasks" | "listing_imbalance" | "spare_capacity" | "stale_payout" | "stalled_tasks" | "single_manager" | "no_agents";
export interface Insight {
  kind: InsightKind;
  severity: "high" | "medium" | "low";
  /** The member the insight is about, when there is one. */
  memberUserId?: string;
  title: string;
  /** What Elena noticed, in plain words. */
  detail: string;
  /** What she suggests. A suggestion only: nothing changes until a manager acts. */
  suggestion: string;
}

const DAY = 86_400_000;
export const STALE_PAYOUT_DAYS = 14;
export const OVERDUE_LIMIT = 3;

/**
 * Elena's read of a team, from rules over the numbers on the dashboard: no model, nothing leaves the server, and every
 * line says what it saw. Suggestions are never carried out for the manager. Most urgent first.
 */
export function buildInsights(rows: readonly DashboardRow[], nowIso: string): Insight[] {
  const out: Insight[] = [];
  const now = Date.parse(nowIso);
  const agents = rows.filter(r => r.role === "agent" || r.role === "manager");
  const managers = rows.filter(r => r.role === "manager");

  if (managers.length === 1 && rows.length >= 4) {
    out.push({ kind: "single_manager", severity: "low", title: "Only one manager", detail: `${managers[0]!.displayName} is the only manager of a ${rows.length}-person team.`, suggestion: "Add a second manager so approvals and task assignment continue when they are away." });
  }
  if (rows.length === 1) {
    out.push({ kind: "no_agents", severity: "low", title: "No agents yet", detail: "This team has no agents or staff besides its manager.", suggestion: "Add team members by email to start sharing listings and tasks." });
  }

  for (const r of rows) {
    if (r.overdueTasks >= OVERDUE_LIMIT) {
      out.push({ kind: "overdue_tasks", severity: "high", memberUserId: r.userId, title: `${r.displayName} has ${r.overdueTasks} overdue tasks`,
        detail: `${r.displayName} has ${r.openTasks} open tasks and ${r.overdueTasks} are past their due date.`,
        suggestion: `Check in with ${r.displayName} and move some of their tasks to someone with room.` });
    } else if (r.openTasks >= 3 && r.doneLast30 === 0) {
      out.push({ kind: "stalled_tasks", severity: "medium", memberUserId: r.userId, title: `${r.displayName} has not finished a task in 30 days`,
        detail: `${r.openTasks} tasks are open for ${r.displayName} and none were completed in the last 30 days.`,
        suggestion: `Ask ${r.displayName} whether the tasks are blocked, and close any that are no longer needed.` });
    }
    if (r.oldestUnpaidAt !== null && r.owedCents !== null && r.owedCents > 0) {
      const days = Math.floor((now - Date.parse(r.oldestUnpaidAt)) / DAY);
      if (days >= STALE_PAYOUT_DAYS) {
        out.push({ kind: "stale_payout", severity: days >= 30 ? "high" : "medium", memberUserId: r.userId, title: `${r.displayName}'s commission has waited ${days} days`,
          detail: `${r.displayName} has commission recorded ${days} days ago that is not yet marked paid.`,
          suggestion: "Approve it and pay it outside the platform, then mark it paid so the record stays accurate." });
      }
    }
  }

  // Listings: compare each agent with the team average once the team is carrying a meaningful load.
  const carriers = agents.filter(r => r.role === "agent" || r.activeListings > 0);
  const total = carriers.reduce((s, r) => s + r.activeListings, 0);
  if (carriers.length >= 2 && total >= 4) {
    const avg = total / carriers.length;
    for (const r of carriers) {
      if (r.activeListings >= 2 * avg && r.activeListings - avg >= 3) {
        out.push({ kind: "listing_imbalance", severity: "medium", memberUserId: r.userId, title: `${r.displayName} carries ${r.activeListings} listings`,
          detail: `The team average is ${avg.toFixed(1)} listings per person and ${r.displayName} holds ${r.activeListings}.`,
          suggestion: "Owners appoint agents, so ask owners if they are happy to move a listing, or send new enquiries to teammates with fewer." });
      } else if (r.role === "agent" && r.activeListings === 0 && avg >= 2) {
        out.push({ kind: "spare_capacity", severity: "low", memberUserId: r.userId, title: `${r.displayName} has no active listings`,
          detail: `${r.displayName} has room while the team averages ${avg.toFixed(1)} listings each.`,
          suggestion: `Point new owner enquiries to ${r.displayName}, and check their agent profile shows the right areas.` });
      }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** One spoken-length summary for Elena to read aloud. */
export function elenaSummary(insights: readonly Insight[], teamName: string): string {
  if (insights.length === 0) return `${teamName} looks healthy. Tasks are on track, listings are spread evenly and no payouts are waiting.`;
  const top = insights[0]!;
  const more = insights.length - 1;
  return `I found ${insights.length} thing${insights.length === 1 ? "" : "s"} worth a look in ${teamName}. The most important: ${top.title}. ${top.suggestion}${more > 0 ? ` There ${more === 1 ? "is" : "are"} ${more} more below.` : ""}`;
}
