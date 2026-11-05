import { randomUUID } from "node:crypto";
import { appendAuditPg, type Queryable } from "./db";
import { scanAgingListings } from "./staff-automation-db";
import { runDueCampaigns, type SendCounts } from "./campaigns-db";
import { runDueTasks } from "./scheduled-tasks-db";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The 15-minute tick: aging-listing rules, campaigns that are due or part way through, and scheduled tasks. Each part is claim-based, so a repeat
 * or overlapping call never sends or runs anything twice. One part failing does not stop the others.
 */
export async function runAutomationTick(db: Queryable, nowIso: string, env: Env): Promise<{ aging: number; campaigns: SendCounts | null; tasks: { due: number; ok: number; failed: number } | null; errors: string[] }> {
  const errors: string[] = [];
  const part = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch { errors.push(name); return null; }
  };
  const aging = (await part("aging", () => scanAgingListings(db, env))) ?? 0;
  const campaigns = await part("campaigns", () => runDueCampaigns(db, nowIso, env));
  const tasks = await part("tasks", () => runDueTasks(db, nowIso, env));
  const result = { aging, campaigns, tasks, errors };
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: nowIso, actorType: "system", actorId: "automation", aggregateType: "job", aggregateId: "automation",
    eventType: "job.staff_automation_run", correlationId: randomUUID(), payload: { ...result }
  });
  return result;
}
