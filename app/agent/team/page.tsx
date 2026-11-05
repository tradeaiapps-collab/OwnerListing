"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/enquiries.css";
import "../../styles/agent-workspace.css";
import "../../styles/agent-team.css";

type Perf = { listings: number; enquiries: number; hot: number; unanswered: number; openOffers: number; pipelineCents: number; closedDeals: number; closedCents: number; acceptanceRate?: number; medianResponseMinutes?: number };
type Split = { grossCents: number; agentCents: number; teamCents: number; agentShareBps: number; pipelineGrossCents: number };
type Row = { userId: string; name: string; role: string; status: string; performance?: Perf; openTasks: number; overdueTasks: number; listings: number; commission?: Split };
type Totals = Omit<Perf, "listings" | "enquiries"> & { members: number; listings: number; enquiries: number; overdue: number; openTasks: number; overdueTasks: number; commission?: { grossCents: number; agentCents: number; teamCents: number } };
type Member = { userId: string; name: string; role: string; status: string; agentShareBps: number };
type Task = { id: string; title: string; listingTitle?: string; assigneeId: string; dueOn?: string; status: "open" | "done" };
type View = { team: { id: string; name: string; commissionRateBps?: number }; role: string; viewerId: string; roster: Member[]; dashboard: { totals: Totals; members: Row[] }; tasks: Task[]; listings: { listingId: string; title: string }[] };
type Mine = { active?: { id: string; name: string; role: string }; invitations: { teamId: string; teamName: string; role: string }[] };
type Answer = { name: string; text: string; suggestions: string[] };

const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const mins = (m: number) => (m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);
const today = () => new Date().toISOString().slice(0, 10);

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}
const json = (method: string, data: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

/** Agent team: roster and roles, performance dashboard, commission splits, task assignment and the assistant. */
export default function AgentTeam() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await call<Mine>("/api/agent/teams");
      if (r.status === 401) return setError("Sign in to use your team.");
      if (!r.ok) return setError(r.body.error ?? "Could not load your team.");
      setMine(r.body); setError("");
      if (r.body.active) {
        const v = await call<View>(`/api/agent/teams/${r.body.active.id}`);
        if (v.ok) setView(v.body); else setError(v.body.error ?? "Could not load your team.");
      } else setView(null);
    } catch { setError("Could not load your team."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(url: string, init: RequestInit, done?: string): Promise<boolean> {
    const r = await call(url, init).catch(() => null);
    if (!r?.ok) { setError(r?.body.error ?? "That did not work. Try again."); setNotice(""); return false; }
    setError(""); setNotice(done ?? ""); await load(); return true;
  }
  const base = view ? `/api/agent/teams/${view.team.id}` : "";
  const me = view?.viewerId ?? "";
  const isMgr = view?.role === "principal" || view?.role === "manager";
  const isPrincipal = view?.role === "principal";
  const nameOf = (id: string) => view?.roster.find(m => m.userId === id)?.name ?? "Former member";

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "");
    await act("/api/agent/teams", json("POST", { name }), "Team created.");
  }
  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), form = e.currentTarget;
    if (await act(`${base}/members`, json("POST", { email: f.get("email"), role: f.get("role") }), "Invitation sent. They join once they accept.")) form.reset();
  }
  async function addTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), form = e.currentTarget;
    const data = { title: f.get("title"), assigneeId: f.get("assigneeId") || undefined, listingId: f.get("listingId") || undefined, dueOn: f.get("dueOn") || undefined };
    if (await act(`${base}/tasks`, json("POST", data), "Task added.")) form.reset();
  }
  async function ask(q: string) {
    if (!q.trim() || !view) return;
    setBusy(true);
    const r = await call<Answer>(`${base}/assistant`, json("POST", { question: q })).catch(() => null);
    setBusy(false);
    setAnswer(r?.ok ? r.body : { name: "Assistant", text: r?.body.error ?? "I could not answer that just now.", suggestions: [] });
  }

  const t = view?.dashboard.totals;
  const active = view?.roster.filter(m => m.status === "active") ?? [];
  const invited = view?.roster.filter(m => m.status === "invited") ?? [];
  return (
    <main className="aw">
      <h1>{view?.team.name ?? "Agent team"}</h1>
      <p><a href="/agent/workspace">My workspace</a> · <a href="/agent/listings">Appointed listings</a></p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!mine && !error && <p className="muted" role="status">Loading…</p>}

      {mine && !mine.active && (
        <section className="aw-card" aria-labelledby="start-h">
          <h2 id="start-h">Start or join a team</h2>
          {mine.invitations.length === 0 && <p className="empty">You have no invitations yet. Create a team to invite other licensed agents.</p>}
          {mine.invitations.map(i => (
            <div key={i.teamId} className="at-invite">
              <span>{i.teamName} invited you as {i.role}.</span>
              <span className="at-inline">
                <button type="button" onClick={() => void act(`/api/agent/teams/${i.teamId}/invitation`, json("PUT", { accept: true }), "You joined the team.")}>Accept</button>
                <button type="button" className="quiet" onClick={() => void act(`/api/agent/teams/${i.teamId}/invitation`, json("PUT", { accept: false }), "Invitation declined.")}>Decline</button>
              </span>
            </div>
          ))}
          <form className="at-form" onSubmit={e => void create(e)}>
            <label>Team name<input name="name" minLength={2} maxLength={80} required /></label>
            <button type="submit">Create team</button>
          </form>
        </section>
      )}

      {view && t && (
        <>
          <ul className="aw-kpis" aria-label="Team performance">
            <li className="aw-kpi"><span>Accepted offers</span><strong>{t.closedDeals}</strong><small>{aud(t.closedCents)}</small></li>
            <li className="aw-kpi"><span>Open pipeline</span><strong>{aud(t.pipelineCents)}</strong><small>{t.openOffers} open offer{t.openOffers === 1 ? "" : "s"}</small></li>
            <li className="aw-kpi"><span>Acceptance rate</span><strong>{t.acceptanceRate === undefined ? "–" : `${t.acceptanceRate}%`}</strong><small>{t.members} active member{t.members === 1 ? "" : "s"}</small></li>
            <li className="aw-kpi"><span>Median first reply</span><strong>{t.medianResponseMinutes === undefined ? "–" : mins(t.medianResponseMinutes)}</strong><small>{t.unanswered} waiting for a reply</small></li>
            <li className="aw-kpi"><span>Listings</span><strong>{t.listings}</strong><small>{t.enquiries} enquiries</small></li>
            <li className="aw-kpi"><span>Open tasks</span><strong>{t.openTasks}</strong><small>{t.overdueTasks} overdue</small></li>
            {t.commission && <li className="aw-kpi"><span>Estimated commission</span><strong>{aud(t.commission.grossCents)}</strong><small>Agents {aud(t.commission.agentCents)} · team {aud(t.commission.teamCents)}</small></li>}
          </ul>
          <div className="aw-main">
            <div className="aw-card">
              <h2 id="members-h">{isMgr ? "Members" : "You"}</h2>
              <p className="at-note">Your role: {view.role}. {isPrincipal ? "Commission figures are estimates from the team rate below." : isMgr ? "Commission splits are visible to the principal." : "You see team totals and your own figures."}</p>
              <ul className="at-members" aria-labelledby="members-h">
                {view.dashboard.members.filter(m => m.status === "active").map(m => {
                  const share = view.roster.find(r => r.userId === m.userId)?.agentShareBps ?? 0;
                  return (
                    <li key={m.userId} className="at-member">
                      <div className="at-head"><strong>{m.name}</strong><span className="at-role">{m.role}</span></div>
                      <dl className="at-stats">
                        <div><dt>Listings</dt><dd>{m.listings}</dd></div>
                        <div><dt>Accepted</dt><dd>{m.performance ? `${m.performance.closedDeals} · ${aud(m.performance.closedCents)}` : "–"}</dd></div>
                        <div><dt>Waiting for reply</dt><dd>{m.performance?.unanswered ?? 0}</dd></div>
                        <div><dt>Tasks</dt><dd>{m.openTasks}{m.overdueTasks > 0 && <span className="at-late"> ({m.overdueTasks} overdue)</span>}</dd></div>
                        {m.commission && <div><dt>Agent commission</dt><dd>{aud(m.commission.agentCents)} of {aud(m.commission.grossCents)}</dd></div>}
                        {m.commission && <div><dt>Team keeps</dt><dd>{aud(m.commission.teamCents)}</dd></div>}
                      </dl>
                      {isPrincipal && (
                        <form className="at-inline" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(`${base}/members/${m.userId}`, json("PATCH", { agentSharePercent: Number(f.get("share")), ...(m.role !== "principal" ? { role: f.get("role") } : {}) }), "Member updated."); }}>
                          <label>Agent share %<input name="share" type="number" min={0} max={100} step={0.5} defaultValue={share / 100} required /></label>
                          {m.role !== "principal" && <label>Role<select name="role" defaultValue={m.role}><option value="agent">agent</option><option value="manager">manager</option></select></label>}
                          <button type="submit">Save</button>
                          {m.role !== "principal" && <button type="button" className="quiet" onClick={() => void act(`${base}/members/${m.userId}`, { method: "DELETE" }, "Member removed.")}>Remove</button>}
                        </form>
                      )}
                      {!isPrincipal && (m.userId === me || (view.role === "manager" && m.role === "agent")) && (
                        <div className="at-inline"><button type="button" className="quiet" onClick={() => void act(`${base}/members/${m.userId}`, { method: "DELETE" }, m.userId === me ? "You left the team." : "Member removed.")}>{m.userId === me ? "Leave team" : "Remove"}</button></div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {isMgr && invited.length > 0 && <p className="at-note" style={{ marginTop: "var(--space-3)" }}>Waiting to accept: {invited.map(m => `${m.name} (${m.role})`).join(", ")}.</p>}
              {isMgr && (
                <form className="at-form wide" onSubmit={e => void invite(e)}>
                  <label>Invite a licensed agent by email<input name="email" type="email" required /></label>
                  <label>Role<select name="role" defaultValue="agent"><option value="agent">agent</option>{isPrincipal && <option value="manager">manager</option>}</select></label>
                  <button type="submit">Send invitation</button>
                </form>
              )}
              {isPrincipal && view.team.commissionRateBps !== undefined && (
                <form className="at-form wide at-section" onSubmit={e => { e.preventDefault(); void act(base, json("PATCH", { commissionRatePercent: Number(new FormData(e.currentTarget).get("rate")) }), "Commission rate saved."); }}>
                  <label>Commission rate % of sale price (assumption)<input name="rate" type="number" min={0} max={10} step={0.05} defaultValue={view.team.commissionRateBps / 100} required /></label>
                  <button type="submit">Save rate</button>
                </form>
              )}

              <section className="at-section" aria-labelledby="tasks-h">
                <h2 id="tasks-h">Tasks</h2>
                {view.tasks.length === 0 && <p className="empty">No tasks yet.</p>}
                <ul className="at-tasks">
                  {view.tasks.map(k => (
                    <li key={k.id} className={`at-task${k.status === "done" ? " done" : ""}`}>
                      <span className="at-title">{k.title}</span>
                      <span className="aw-meta">{nameOf(k.assigneeId)}{k.listingTitle ? ` · ${k.listingTitle}` : ""}{k.dueOn ? ` · due ${k.dueOn}` : ""}{k.status === "open" && k.dueOn && k.dueOn < today() ? <span className="at-late"> · overdue</span> : null}</span>
                      <div className="at-inline"><button type="button" onClick={() => void act(`${base}/tasks/${k.id}`, json("PATCH", { status: k.status === "done" ? "open" : "done" }))}>{k.status === "done" ? "Reopen" : "Mark done"}</button></div>
                    </li>
                  ))}
                </ul>
                <form className="at-form wide" onSubmit={e => void addTask(e)}>
                  <label>Task<input name="title" maxLength={200} required /></label>
                  {isMgr && <label>Assign to<select name="assigneeId" defaultValue="">{<option value="">Me</option>}{active.map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></label>}
                  <label>Listing (optional)<select name="listingId" defaultValue=""><option value="">None</option>{[...new Map(view.listings.map(l => [l.listingId, l.title])).entries()].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
                  <label>Due<input name="dueOn" type="date" /></label>
                  <button type="submit">Add task</button>
                </form>
              </section>
            </div>
            <aside className="aw-card aw-elena" aria-labelledby="elena-h">
              <div className="aw-elena-head">
                <img src="/assistant/elena-pose-tablet.jpg" alt="" width={56} height={56} />
                <div><h2 id="elena-h" style={{ margin: 0 }}>{answer?.name ?? "Elena"}</h2><small>AI assistant, not a licensed agent</small></div>
              </div>
              <p className="aw-answer" role="status" aria-live="polite">{busy ? "Looking at your team's numbers…" : answer?.text ?? (isMgr ? "Ask me how the team is performing, what to improve, or who has overdue tasks." : "Ask me about the team totals or your tasks.")}</p>
              <div className="aw-chips">
                {(answer?.suggestions?.length ? answer.suggestions : isMgr ? ["How is the team performing?", "What should we improve?", "Who has overdue tasks?"] : ["How is the team performing?", "What are my tasks?"]).map(s => (
                  <button key={s} type="button" onClick={() => void ask(s)}>{s}</button>
                ))}
              </div>
              <form className="aw-ask" onSubmit={e => { e.preventDefault(); void ask(question); setQuestion(""); }}>
                <input value={question} onChange={e => setQuestion(e.target.value)} maxLength={500} aria-label="Ask the assistant" placeholder="Ask a question" />
                <button type="submit" disabled={busy}>Ask</button>
              </form>
              {isPrincipal && <button type="button" className="quiet" style={{ minHeight: 44 }} onClick={() => { if (window.confirm("Close this team? Every membership ends.")) void act(base, { method: "DELETE" }, "Team closed."); }}>Close team</button>}
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
