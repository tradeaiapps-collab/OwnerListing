"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff, sendStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/automation.css";

interface Rule { id: string; name: string; enabled: boolean; summary: string; messageKind: string; title: string; runs: number; lastFiredAt: string | null }
interface Task { id: string; name: string; kind: string; enabled: boolean; summary: string; nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; lastDetail: string | null }
interface Run { id: string; ruleName: string; eventKey: string; recipients: number; createdAt: string }
interface TaskRun { id: string; taskName: string; startedAt: string; status: string; affected: number; detail: string | null; source: string }
interface TriggerInfo { label: string; help: string; recipients: string[] }
interface Data { rules: Rule[]; runs: Run[]; tasks: Task[]; taskRuns: TaskRun[]; triggers: Record<string, TriggerInfo>; taskKinds: Record<string, { label: string; help: string }> }

const RECIPIENTS: Record<string, string> = { owner: "The listing owner", agent: "The appointed agent", buyer: "The buyer", owner_and_agent: "Owner and agent" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RULE_BLANK = { name: "", trigger: "offer_received", days: "90", views: "3", windowDays: "14", recipient: "owner", messageKind: "system_notice", title: "", body: "", link: "" };
const TASK_BLANK = { name: "", kind: "archive_stale_listings", days: "365", cadence: "daily", hour: "9", weekday: "1", dayOfMonth: "1", runAt: "" };
const when = (v: string | null) => (v ? new Date(v).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "Never");

/**
 * Workflow rules ("when X happens, tell Y") and scheduled tasks (bulk actions at set times). Rules send notifications through the notification
 * centre, so each person's own channel choices and opt-outs still apply. Times are Brisbane time.
 */
export default function StaffAutomation() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rule, setRule] = useState(RULE_BLANK);
  const [task, setTask] = useState(TASK_BLANK);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/automation").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setData(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  const info = data?.triggers[rule.trigger];
  const recipientOptions = info?.recipients ?? ["owner"];

  async function done(res: { ok: boolean; data: Record<string, unknown> }, ok: string) {
    setBusy(false);
    if (!res.ok) { setError(String(res.data["error"] ?? "Could not save.")); setNotice(""); return false; }
    setError(""); setNotice(ok); await load(); return true;
  }

  async function addRule() {
    setBusy(true);
    const triggerConfig = rule.trigger === "listing_aging" ? { days: Number(rule.days) } : rule.trigger === "listing_viewed_repeat" ? { views: Number(rule.views), windowDays: Number(rule.windowDays) } : {};
    const res = await postStaff("/api/staff/automation", { resource: "rule", name: rule.name, trigger: rule.trigger, triggerConfig, recipient: rule.recipient, messageKind: rule.messageKind, title: rule.title, body: rule.body, link: rule.link });
    if (await done(res, "Rule saved and switched on.")) setRule(RULE_BLANK);
  }
  async function addTask() {
    setBusy(true);
    const res = await postStaff("/api/staff/automation", {
      resource: "task", name: task.name, kind: task.kind, config: task.kind === "invite_reminders" ? {} : { days: Number(task.days) }, cadence: task.cadence,
      hour: Number(task.hour), weekday: Number(task.weekday), dayOfMonth: Number(task.dayOfMonth), runAt: task.runAt ? new Date(task.runAt).toISOString() : ""
    });
    if (await done(res, "Task scheduled.")) setTask(TASK_BLANK);
  }
  const act = async (url: string, method: "PATCH" | "DELETE", body: unknown, ok: string) => { setBusy(true); await done(await sendStaff(method, url, body), ok); };

  const setR = (k: keyof typeof RULE_BLANK) => (e: { target: { value: string } }) => {
    const next = { ...rule, [k]: e.target.value };
    if (k === "trigger") { const first = data?.triggers[e.target.value]?.recipients[0]; if (first) next.recipient = first; next.messageKind = "system_notice"; }
    setRule(next);
  };
  const setT = (k: keyof typeof TASK_BLANK) => (e: { target: { value: string } }) => setTask({ ...task, [k]: e.target.value });

  return (
    <main className="admin-page automation">
      <h1>Automation</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">
        Rules tell owners, agents or buyers when something happens. They send ordinary notifications, so each person&rsquo;s own channel choices apply.
        Scheduled tasks run bulk actions at a set time (Brisbane time). Both are checked every 15 minutes. Every change here is logged.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <section className="au-section" aria-labelledby="au-rules">
            <h2 id="au-rules">Workflow rules</h2>
            {data.rules.length === 0
              ? <p className="empty">No rules yet. Add one below, for example &ldquo;when an offer is received, tell the owner and the agent&rdquo;.</p>
              : <div className="table-wrap"><table className="au-table">
                <thead><tr><th scope="col">Rule</th><th scope="col" className="au-wide">Message</th><th scope="col" className="au-num">Times run</th></tr></thead>
                <tbody>{data.rules.map(r => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong><br /><span className="muted">{r.summary}</span><br />
                      <span className={`status-pill ${r.enabled ? "good" : "bad"}`}>{r.enabled ? "On" : "Off"}</span>
                      <div className="row-actions">
                        <button type="button" className="secondary" disabled={busy} onClick={() => void act(`/api/staff/automation/${r.id}`, "PATCH", { action: r.enabled ? "disable" : "enable" }, r.enabled ? "Rule switched off." : "Rule switched on.")}>{r.enabled ? "Turn off" : "Turn on"}</button>
                        <button type="button" className="danger" disabled={busy} onClick={() => void act(`/api/staff/automation/${r.id}`, "DELETE", undefined, "Rule removed (or switched off, as it has history).")}>Remove</button>
                      </div>
                    </td>
                    <td>{r.title}<br /><span className="muted">{r.messageKind === "marketing_news" ? "Marketing (opted-in buyers only)" : "Account notice"}</span></td>
                    <td className="au-num">{r.runs}<br /><span className="muted">{r.lastFiredAt ? when(r.lastFiredAt) : "never"}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>}
            <details className="au-add">
              <summary>Add a rule</summary>
              <form className="stack" onSubmit={e => { e.preventDefault(); void addRule(); }}>
                <label>Name<input required minLength={3} maxLength={120} value={rule.name} onChange={setR("name")} /></label>
                <label>When<select value={rule.trigger} onChange={setR("trigger")}>{Object.entries(data.triggers).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
                {rule.trigger === "listing_aging" && <label>Days live<input type="number" min={7} max={730} required value={rule.days} onChange={setR("days")} /></label>}
                {rule.trigger === "listing_viewed_repeat" && <>
                  <label>Views<input type="number" min={2} max={20} required value={rule.views} onChange={setR("views")} /></label>
                  <label>Within (days)<input type="number" min={1} max={90} required value={rule.windowDays} onChange={setR("windowDays")} /></label>
                </>}
                <label>Tell<select value={rule.recipient} onChange={setR("recipient")}>{recipientOptions.map(k => <option key={k} value={k}>{RECIPIENTS[k]}</option>)}</select></label>
                {rule.recipient === "buyer" && rule.trigger !== "offer_received" && (
                  <label>Kind of message<select value={rule.messageKind} onChange={setR("messageKind")}><option value="system_notice">Account notice</option><option value="marketing_news">Marketing follow-up (opted-in buyers only)</option></select></label>
                )}
                <label>Title<input required maxLength={80} value={rule.title} onChange={setR("title")} /></label>
                <label>Page to open (optional)<input maxLength={300} placeholder="/listings/mine" value={rule.link} onChange={setR("link")} /></label>
                <label>Message<textarea required maxLength={400} value={rule.body} onChange={setR("body")} /></label>
                <p className="muted au-full au-help">{info?.help} You can use {"{listing}"}, {"{count}"} and {"{days}"} in the title and message.</p>
                <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save rule"}</button>
              </form>
            </details>
          </section>

          <section className="au-section" aria-labelledby="au-tasks">
            <h2 id="au-tasks">Scheduled tasks</h2>
            {data.tasks.length === 0
              ? <p className="empty">No scheduled tasks yet.</p>
              : <div className="table-wrap"><table className="au-table">
                <thead><tr><th scope="col">Task</th><th scope="col">Next run</th><th scope="col" className="au-wide">Last run</th></tr></thead>
                <tbody>{data.tasks.map(t => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong><br /><span className="muted">{data.taskKinds[t.kind]?.label}. {t.summary}</span><br />
                      <span className={`status-pill ${t.enabled ? "good" : "bad"}`}>{t.enabled ? "On" : "Off"}</span>
                      <div className="row-actions">
                        <button type="button" className="secondary" disabled={busy} onClick={() => void act(`/api/staff/automation/${t.id}?resource=task`, "PATCH", { action: "run" }, "Task ran once now.")}>Run now</button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => void act(`/api/staff/automation/${t.id}?resource=task`, "PATCH", { action: t.enabled ? "disable" : "enable" }, t.enabled ? "Task switched off." : "Task switched on.")}>{t.enabled ? "Turn off" : "Turn on"}</button>
                        <button type="button" className="danger" disabled={busy} onClick={() => void act(`/api/staff/automation/${t.id}?resource=task`, "DELETE", undefined, "Task removed (or switched off, as it has history).")}>Remove</button>
                      </div>
                    </td>
                    <td>{t.enabled ? when(t.nextRunAt) : "Off"}</td>
                    <td>{when(t.lastRunAt)}{t.lastDetail && <><br /><span className="muted">{t.lastDetail}</span></>}</td>
                  </tr>
                ))}</tbody>
              </table></div>}
            <details className="au-add">
              <summary>Schedule a task</summary>
              <form className="stack" onSubmit={e => { e.preventDefault(); void addTask(); }}>
                <label>Name<input required minLength={3} maxLength={120} value={task.name} onChange={setT("name")} /></label>
                <label>What<select value={task.kind} onChange={setT("kind")}>{Object.entries(data.taskKinds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
                {task.kind !== "invite_reminders" && <label>{task.kind === "archive_stale_listings" ? "Idle for (days)" : "Summary covers (days)"}<input type="number" min={task.kind === "archive_stale_listings" ? 30 : 1} max={task.kind === "archive_stale_listings" ? 1825 : 90} required value={task.days} onChange={setT("days")} /></label>}
                <label>How often<select value={task.cadence} onChange={setT("cadence")}><option value="once">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></label>
                {task.cadence === "once"
                  ? <label>Run at<input type="datetime-local" required value={task.runAt} onChange={setT("runAt")} /></label>
                  : <label>Hour (Brisbane)<input type="number" min={0} max={23} required value={task.hour} onChange={setT("hour")} /></label>}
                {task.cadence === "weekly" && <label>Weekday<select value={task.weekday} onChange={setT("weekday")}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>}
                {task.cadence === "monthly" && <label>Day of month<input type="number" min={1} max={28} required value={task.dayOfMonth} onChange={setT("dayOfMonth")} /></label>}
                <p className="muted au-full au-help">{data.taskKinds[task.kind]?.help}</p>
                <button type="submit" disabled={busy}>{busy ? "Saving…" : "Schedule task"}</button>
              </form>
            </details>
          </section>

          <section className="au-section" aria-labelledby="au-activity">
            <h2 id="au-activity">Recent activity</h2>
            {data.runs.length === 0 && data.taskRuns.length === 0 ? <p className="empty">Nothing has run yet.</p> : (
              <div className="table-wrap"><table className="au-table">
                <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col" className="au-wide">Result</th></tr></thead>
                <tbody>
                  {[...data.runs.map(r => ({ at: r.createdAt, key: `r${r.id}`, what: `Rule: ${r.ruleName}`, result: `Told ${r.recipients} ${r.recipients === 1 ? "person" : "people"} (${r.eventKey})` })),
                    ...data.taskRuns.map(r => ({ at: r.startedAt, key: `t${r.id}`, what: `Task: ${r.taskName}${r.source === "manual" ? " (run by hand)" : ""}`, result: `${r.status === "ok" ? "Done" : "Failed"}. ${r.detail ?? ""}` }))]
                    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40)
                    .map(r => <tr key={r.key}><td>{when(r.at)}</td><td>{r.what}</td><td>{r.result}</td></tr>)}
                </tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
