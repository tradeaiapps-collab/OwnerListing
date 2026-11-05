"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";
import { PRESENTER_SPEAK_EVENT } from "../../presenter/presenter-core";
import { EarningsSummary, PayDialog, PayoutAccountCard } from "./payouts-ui";

type Role = "manager" | "agent" | "staff";
type Member = { userId: string; displayName: string; role: Role; memberBps: number | null; email?: string };
type Detail = { team: { id: string; name: string; kind: string; defaultMemberBps: number }; myRole: Role; me: string; members: Member[] };
type Row = {
  userId: string; displayName: string; role: Role; activeListings: number; openTasks: number; overdueTasks: number; doneLast30: number;
  owedCents: number | null; paidCents: number | null; recordedCents: number | null;
};
type Insight = { kind: string; severity: "high" | "medium" | "low"; title: string; detail: string; suggestion: string };
type Dashboard = {
  rows: Row[]; totals: { members: number; activeListings: number; openTasks: number; overdueTasks: number; doneLast30: number; owedCents: number | null };
  insights: Insight[] | null; summary: string | null;
};
type Task = { id: string; title: string; notes: string; assigneeUserId: string; dueDate: string | null; status: "open" | "in_progress" | "done" };
type Commission = {
  id: string; memberUserId: string; description: string; grossCents: number; memberBps: number; memberCents: number; officeCents: number;
  status: "recorded" | "approved" | "paid"; payoutReference: string; createdAt: string; paidAt?: string | null;
};

const TABS = [["overview", "Overview"], ["members", "Members"], ["tasks", "Tasks"], ["commissions", "Commissions"]] as const;
type Tab = typeof TABS[number][0];
const money = (c: number | null) => (c === null ? "–" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(c / 100));
const pct = (bps: number) => `${bps / 100}%`;
const ROLE_LABEL: Record<Role, string> = { manager: "Manager", agent: "Agent", staff: "Staff" };
const STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", done: "Done", recorded: "Pending approval", approved: "Approved, ready to pay", paid: "Paid" };

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const r = await fetch(url, { method, ...(body !== undefined ? { headers: JSON_HEADERS, body: JSON.stringify(body) } : method !== "GET" ? { headers: JSON_HEADERS } : {}) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Network problem. Try again." } };
  }
}

/** One team: Elena's read and performance, members and roles, tasks, and commission splits with a payout record. */
export default function TeamPage() {
  const id = String(useParams<{ id: string }>().id);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [payoutInfo, setPayoutInfo] = useState<{ enabled: boolean; verified: string[] }>({ enabled: false, verified: [] });
  const [paying, setPaying] = useState<Commission | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [msg, setMsg] = useState("");

  const reload = useCallback(async () => {
    const [d, db, t, c] = await Promise.all([call(`/api/teams/${id}`, "GET"), call(`/api/teams/${id}/dashboard`, "GET"), call(`/api/teams/${id}/tasks`, "GET"), call(`/api/teams/${id}/commissions`, "GET")]);
    if (!d.ok) return setLoadError(d.data.error ?? "Could not load this team.");
    setDetail(d.data.detail);
    if (db.ok) setDash(db.data.dashboard);
    if (t.ok) setTasks(t.data.tasks);
    if (c.ok) {
      setCommissions(c.data.commissions);
      const users = [...new Set((c.data.commissions as Commission[]).filter(x => x.status === "approved").map(x => x.memberUserId))].join(",");
      const p = await call(`/api/teams/${id}/payouts?users=${users}`, "GET");
      if (p.ok) setPayoutInfo({ enabled: p.data.enabled === true, verified: p.data.verifiedUserIds ?? [] });
    }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  async function act(url: string, method: string, body?: unknown, ok = "") {
    setMsg("");
    const r = await call(url, method, body);
    if (r.ok) { setMsg(ok); await reload(); } else setMsg(r.data.error ?? "That did not work.");
    return r.ok;
  }

  if (loadError) return <main className="team-page"><p role="alert">{loadError}</p><p><Link href="/teams">Back to your teams</Link></p></main>;
  if (!detail) return <main className="team-page"><p className="muted" role="status">Loading…</p></main>;

  const { team, myRole, members, me } = detail;
  const isManager = myRole === "manager";
  const nameOf = (uid: string) => members.find(m => m.userId === uid)?.displayName ?? "Former member";
  const earners = members.filter(m => m.role !== "staff");

  return (
    <main className="team-page">
      <p><Link href="/teams">All teams</Link></p>
      <h1>{team.name}</h1>
      <p className="muted">{team.kind === "office" ? "Office" : "Team"} · You are {myRole === "agent" ? "an agent" : `a ${myRole}`} · Default split {pct(team.defaultMemberBps)} to the agent, the rest to the agency</p>
      {isManager && <p><Link href={`/teams/${id}/analytics`}>Team analytics</Link> · <Link href={`/agent/reports?team=${id}`}>Team reports</Link> · <Link href={`/teams/${id}/brand`}>Agency brand</Link></p>}
      <ul className="team-tabs" role="tablist" aria-label="Team sections">
        {TABS.map(([k, label]) => (
          <li key={k} role="presentation"><button type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setMsg(""); }}>{label}</button></li>
        ))}
      </ul>
      {msg && <p role="status">{msg}</p>}

      {tab === "overview" && dash && (
        <section className="team-page" aria-label="Performance">
          {dash.insights && (
            <div className="elena-card">
              <img src="/assistant/elena-icon.png" alt="" width={56} height={56} />
              <div>
                <h2>Elena&apos;s read</h2>
                <p>{dash.summary}</p>
                {dash.summary && (
                  <button type="button" className="secondary" onClick={() => window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: dash.summary } }))}>Read it aloud</button>
                )}
                {dash.insights.length > 0 && (
                  <ul className="elena-list">
                    {dash.insights.map((i, n) => (
                      <li key={n} data-sev={i.severity}><strong>{i.title}</strong>{i.detail} <em>{i.suggestion}</em></li>
                    ))}
                  </ul>
                )}
                <p className="muted">Suggestions only, worked out from the numbers below. Nothing changes until you act.</p>
              </div>
            </div>
          )}
          <dl className="team-kpis">
            <div className="team-kpi"><dt>People</dt><dd>{dash.totals.members}</dd></div>
            <div className="team-kpi"><dt>Active listings</dt><dd>{dash.totals.activeListings}</dd></div>
            <div className="team-kpi"><dt>Open tasks</dt><dd>{dash.totals.openTasks}</dd></div>
            <div className="team-kpi"><dt>Overdue tasks</dt><dd>{dash.totals.overdueTasks}</dd></div>
            <div className="team-kpi"><dt>Tasks done (30 days)</dt><dd>{dash.totals.doneLast30}</dd></div>
            {isManager && <div className="team-kpi"><dt>Commission owed</dt><dd>{money(dash.totals.owedCents)}</dd></div>}
          </dl>
          <div className="team-table-wrap">
            <table className="team-table">
              <caption className="sr-only">Performance by person</caption>
              <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col" className="num">Listings</th><th scope="col" className="num">Open</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Done (30d)</th><th scope="col" className="num">Owed</th><th scope="col" className="num">Paid (90d)</th></tr></thead>
              <tbody>
                {dash.rows.map(r => (
                  <tr key={r.userId}>
                    <td className="name">{r.displayName}</td><td>{ROLE_LABEL[r.role]}</td>
                    <td className="num">{r.activeListings}</td><td className="num">{r.openTasks}</td>
                    <td className="num">{r.overdueTasks > 0 ? <span className="team-late">{r.overdueTasks}</span> : 0}</td>
                    <td className="num">{r.doneLast30}</td><td className="num">{money(r.owedCents)}</td><td className="num">{money(r.paidCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === "overview" && !dash && <p className="muted">Performance is not available right now.</p>}

      {tab === "members" && (
        <section className="team-page" aria-label="Members">
          {isManager && <MemberAdd onAdd={(email, role) => act(`/api/teams/${id}/members`, "POST", { email, role }, "Member added.")} />}
          {isManager && <SettingsForm team={team} onSave={(name, bps) => act(`/api/teams/${id}`, "PATCH", { name, defaultMemberBps: bps }, "Team updated.")} />}
          <div className="team-table-wrap">
            <table className="team-table">
              <caption className="sr-only">Team members</caption>
              <thead><tr><th scope="col">Person</th>{isManager && <th scope="col">Email</th>}<th scope="col">Role</th><th scope="col" className="num">Agent share</th><th scope="col" className="team-actions">Actions</th></tr></thead>
              <tbody>
                {members.map(m => (
                  <tr key={m.userId}>
                    <td className="name">{m.displayName}</td>
                    {isManager && <td className="name">{m.email}</td>}
                    <td>{isManager ? (
                      <select aria-label={`Role for ${m.displayName}`} value={m.role} onChange={e => void act(`/api/teams/${id}/members/${m.userId}`, "PATCH", { role: e.target.value }, "Role updated.")}>
                        <option value="manager">Manager</option><option value="agent">Agent</option><option value="staff">Staff</option>
                      </select>) : ROLE_LABEL[m.role]}</td>
                    <td className="num">{m.role === "staff" ? "–" : isManager ? (
                      <input type="number" min={0} max={100} step={0.5} aria-label={`Agent share percent for ${m.displayName}`} defaultValue={m.memberBps === null ? "" : m.memberBps / 100} placeholder={String(team.defaultMemberBps / 100)}
                        onBlur={e => { const v = e.target.value.trim(); const next = v === "" ? null : Math.round(Number(v) * 100); if (next !== m.memberBps) void act(`/api/teams/${id}/members/${m.userId}`, "PATCH", { memberBps: next }, "Split updated."); }} />
                    ) : m.memberBps !== null ? pct(m.memberBps) : "–"}</td>
                    <td className="team-actions">
                      {(isManager || m.userId === me) && <button type="button" className="secondary" onClick={() => void act(`/api/teams/${id}/members/${m.userId}`, "DELETE", undefined, "Removed.")}>{m.userId === me ? "Leave" : "Remove"}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">People can only be removed once their open tasks are reassigned, and a team always keeps one manager. Percent is the share the agent keeps; leave blank for the team default.</p>
        </section>
      )}

      {tab === "tasks" && (
        <section className="team-page" aria-label="Tasks">
          <TaskForm members={members} isManager={isManager} onCreate={body => act(`/api/teams/${id}/tasks`, "POST", body, "Task added.")} />
          {tasks.length === 0 ? <p className="muted">No tasks yet.</p> : (
            <div className="team-table-wrap">
              <table className="team-table">
                <caption className="sr-only">Tasks</caption>
                <thead><tr><th scope="col">Task</th><th scope="col">For</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {tasks.map(t => (
                    <tr key={t.id}>
                      <td className="name">{t.title}</td><td className="name">{nameOf(t.assigneeUserId)}</td>
                      <td>{t.dueDate ? (t.status !== "done" && t.dueDate < new Date().toISOString().slice(0, 10) ? <span className="team-late">{t.dueDate} (overdue)</span> : t.dueDate) : "–"}</td>
                      <td>
                        <select aria-label={`Status of ${t.title}`} value={t.status} onChange={e => void act(`/api/teams/${id}/tasks/${t.id}`, "PATCH", { status: e.target.value })}>
                          {Object.entries({ open: "Open", in_progress: "In progress", done: "Done" }).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!isManager && <p className="muted">You see the tasks assigned to you. Managers assign tasks to others.</p>}
        </section>
      )}

      {tab === "commissions" && (
        <section className="team-page" aria-label="Commissions">
          <p className="muted">The platform never holds commission money. {payoutInfo.enabled ? "Payouts go from the agency's Stripe account straight to the agent." : "The agency pays outside the platform, then a manager marks the entry paid."}</p>
          {myRole !== "staff" && <PayoutAccountCard teamId={id} />}
          {myRole !== "staff" && <EarningsSummary commissions={commissions} me={me} />}
          {isManager && <CommissionForm earners={earners} onRecord={body => act(`/api/teams/${id}/commissions`, "POST", body, "Commission recorded.")} />}
          {myRole === "staff" && <p className="muted">Staff do not see commission.</p>}
          {myRole !== "staff" && commissions.length === 0 && <p className="muted">No commission recorded yet.</p>}
          {commissions.length > 0 && (
            <div className="team-table-wrap">
              <table className="team-table">
                <caption className="sr-only">Commission records</caption>
                <thead><tr><th scope="col">Date</th><th scope="col">Agent</th><th scope="col">For</th><th scope="col" className="num">Gross</th><th scope="col" className="num">Split</th><th scope="col" className="num">Agent</th><th scope="col" className="num">Agency</th><th scope="col">Status</th>{isManager && <th scope="col" className="team-actions">Actions</th>}</tr></thead>
                <tbody>
                  {commissions.map(c => (
                    <tr key={c.id}>
                      <td>{c.createdAt.slice(0, 10)}</td><td className="name">{nameOf(c.memberUserId)}</td><td className="name">{c.description || "–"}</td>
                      <td className="num">{money(c.grossCents)}</td><td className="num">{pct(c.memberBps)}</td><td className="num">{money(c.memberCents)}</td><td className="num">{money(c.officeCents)}</td>
                      <td><span className="team-status" data-s={c.status}>{STATUS_LABEL[c.status]}</span>{c.status === "paid" && c.paidAt ? ` ${c.paidAt.slice(0, 10)}` : ""}{c.payoutReference ? ` · ${c.payoutReference}` : ""}</td>
                      {isManager && (
                        <td className="team-actions">
                          {c.status === "recorded" && <button type="button" onClick={() => void act(`/api/teams/${id}/commissions/${c.id}`, "PATCH", { action: "approve" }, "Approved.")}>Approve</button>}
                          {c.status === "approved" && payoutInfo.enabled && c.memberUserId === me && <span className="muted">Another manager must pay this</span>}
                          {c.status === "approved" && payoutInfo.enabled && c.memberUserId !== me && payoutInfo.verified.includes(c.memberUserId) && <button type="button" onClick={() => setPaying(c)}>Pay</button>}
                          {c.status === "approved" && payoutInfo.enabled && c.memberUserId !== me && !payoutInfo.verified.includes(c.memberUserId) && <span className="muted">Agent has not set up payouts</span>}
                          {c.status === "approved" && <button type="button" className="secondary" onClick={() => { const ref = window.prompt("Payment reference (optional), for example the EFT number") ?? null; if (ref !== null) void act(`/api/teams/${id}/commissions/${c.id}`, "PATCH", { action: "mark_paid", payoutReference: ref }, "Marked paid."); }}>Mark paid</button>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {paying && <PayDialog commission={paying} agentName={nameOf(paying.memberUserId)} teamId={id} onClose={() => setPaying(null)} onDone={m => { setPaying(null); setMsg(m); void reload(); }} />}
    </main>
  );
}

function MemberAdd({ onAdd }: { onAdd: (email: string, role: string) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("agent");
  return (
    <form className="team-inline" onSubmit={async e => { e.preventDefault(); if (await onAdd(email, role)) setEmail(""); }}>
      <label>Add by email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="agent@example.com" /></label>
      <label>Role<select value={role} onChange={e => setRole(e.target.value)}><option value="agent">Agent</option><option value="staff">Staff</option><option value="manager">Manager</option></select></label>
      <button type="submit">Add</button>
    </form>
  );
}

function SettingsForm({ team, onSave }: { team: Detail["team"]; onSave: (name: string, bps: number) => Promise<boolean> }) {
  const [name, setName] = useState(team.name);
  const [share, setShare] = useState(String(team.defaultMemberBps / 100));
  return (
    <form className="team-inline" onSubmit={async e => { e.preventDefault(); await onSave(name, Math.round(Number(share) * 100)); }}>
      <label>Team name<input value={name} onChange={e => setName(e.target.value)} minLength={2} maxLength={80} required /></label>
      <label>Default agent share (%)<input type="number" min={0} max={100} step={0.5} value={share} onChange={e => setShare(e.target.value)} required /></label>
      <button type="submit" className="secondary">Save</button>
    </form>
  );
}

function TaskForm({ members, isManager, onCreate }: { members: Member[]; isManager: boolean; onCreate: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  return (
    <form className="team-inline" onSubmit={async e => {
      e.preventDefault();
      const body: Record<string, unknown> = { title, dueDate: due || null };
      if (isManager && assignee) body["assigneeUserId"] = assignee;
      if (await onCreate(body)) { setTitle(""); setDue(""); }
    }}>
      <label>New task<input value={title} onChange={e => setTitle(e.target.value)} minLength={2} maxLength={200} required /></label>
      {isManager && (
        <label>For<select value={assignee} onChange={e => setAssignee(e.target.value)}>
          <option value="">Me</option>
          {members.map(m => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
        </select></label>
      )}
      <label>Due<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label>
      <button type="submit">Add task</button>
    </form>
  );
}

function CommissionForm({ earners, onRecord }: { earners: Member[]; onRecord: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [member, setMember] = useState("");
  const [dollars, setDollars] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form className="team-inline" onSubmit={async e => {
      e.preventDefault();
      if (await onRecord({ memberUserId: member || earners[0]?.userId, grossCents: Math.round(Number(dollars) * 100), description })) { setDollars(""); setDescription(""); }
    }}>
      <label>Agent<select value={member || earners[0]?.userId || ""} onChange={e => setMember(e.target.value)}>
        {earners.map(m => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
      </select></label>
      <label>Gross commission ($)<input type="number" min={0.01} step={0.01} value={dollars} onChange={e => setDollars(e.target.value)} required /></label>
      <label>What for<input value={description} onChange={e => setDescription(e.target.value)} maxLength={200} placeholder="12 Smith St sale" /></label>
      <button type="submit">Record</button>
    </form>
  );
}
