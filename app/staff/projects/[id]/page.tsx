"use client";
import { use, useCallback, useEffect, useState } from "react";
import { aud, FEATURE_STATUSES, HEALTH_LABEL, PHASES, PR_STATUSES, STATUS_LABEL, type FeatureStatus, type PrStatus } from "../../../../src/domain/staff-project";
import type { ProjectDetail } from "../../../../src/server/staff-project-db";
import { loadError, postStaff } from "../../staff-api";
import "../../../styles/admin.css";
import "../../../styles/projects.css";

interface Can { manage: boolean; techLead: boolean; review: boolean; self: string }
const label = (s: string) => s.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

/** One project: approval, feasibility and risks, milestones, features and linked PRs. */
export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [can, setCan] = useState<Can | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dec, setDec] = useState({ as: "stakeholder", comments: "" });
  const [ms, setMs] = useState({ phase: "build", description: "", targetDate: "" });
  const [feat, setFeat] = useState("");
  const [pr, setPr] = useState({ prNumber: "", title: "", status: "open" });
  const [text, setText] = useState("");
  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/projects/${id}`).catch(() => null);
    if (!r || !r.ok) { setError(r?.status === 404 ? "Project not found." : loadError(r?.status ?? 0)); return; }
    const j = await r.json(); setP(j.project); setCan(j.can); setError("");
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function send(body: Record<string, unknown>, ok: string) {
    setMessage("");
    const res = await postStaff(`/api/staff/projects/${id}`, body);
    setMessage(res.ok ? ok : String(res.data["error"] ?? "Could not save."));
    if (res.ok) await load();
    return res.ok;
  }
  if (error) return <main className="admin-page"><p role="alert">{error}</p><p><a href="/staff/projects">Back to projects</a></p></main>;
  if (!p || !can) return <main className="admin-page"><p className="muted" role="status">Loading…</p></main>;
  const live = p.status === "active", editable = can.manage && p.status !== "rejected" && p.status !== "completed";
  const mayDecide = p.status === "pending_approval" && p.createdBy !== can.self && p.ownerId !== can.self && (can.techLead || can.review);
  const roles = [...(can.techLead ? ["tech_lead"] : []), ...(can.review ? ["stakeholder"] : [])];
  const h = p.health;
  return (
    <main className="admin-page">
      <h1>{p.title}</h1>
      <p><a href="/staff/projects">Back to projects</a></p>
      <p><span className={`proj-status ${live ? h.health : ""}`}>{live ? HEALTH_LABEL[h.health] : STATUS_LABEL[p.status as keyof typeof STATUS_LABEL]}</span>{p.escalatedAt && live ? " Sent to the CTO: no progress for more than 5 days." : ""}</p>
      <p>{p.description}</p>
      <dl className="settle-dates">
        <div><dt>Goal</dt><dd>{p.goal}</dd></div><div><dt>Owner</dt><dd>{p.ownerName}</dd></div>
        <div><dt>Team</dt><dd>{p.memberNames.join(", ") || "None added"}</dd></div>
        <div><dt>Dates</dt><dd>{p.startDate} to {p.endDate}</dd></div><div><dt>Budget</dt><dd>{aud(p.budgetCents)}</dd></div>
        <div><dt>Effort</dt><dd>{p.storyPoints} points, {p.estimatedHours} hours, {p.estimatedDays} days, {p.teamSize} people</dd></div>
        {p.approvedAt && <div><dt>Approved</dt><dd>{p.approvedByName} on {p.approvedAt.slice(0, 10)}</dd></div>}
      </dl>
      {message && <p role="status">{message}</p>}
      {live && <div className="proj-meter"><progress max={100} value={h.progress} aria-label="Milestones done" /><span>{h.progress}% of milestones · {h.daysRemaining >= 0 ? `${h.daysRemaining} days left` : `${-h.daysRemaining} days late`}</span></div>}
      {live && h.reasons.length > 0 && <ul className="proj-reasons">{h.reasons.map(r => <li key={r}>{r}</li>)}</ul>}

      <section className="proj-section"><h2>Feasibility</h2>
        <p>{p.feasibility.brief}</p>
        <ul className="proj-risks">{p.feasibility.lines.map(l => <li key={l.key} className={l.ok ? "" : "medium"}>{l.ok ? "Yes" : "Open"}: {l.label}. {l.note}</li>)}</ul>
        {p.assumptions && <p><strong>Assumptions:</strong> {p.assumptions}</p>}
        {p.unknowns && <p><strong>Unknowns:</strong> {p.unknowns}</p>}
        <h3>Risk flags</h3>
        {p.risks.length === 0 ? <p className="muted">None.</p> : <ul className="proj-risks">{p.risks.map(r => <li key={r.type} className={r.severity}><strong>{label(r.type)}</strong> ({r.severity}): {r.description}</li>)}</ul>}
      </section>

      <section className="proj-section"><h2>Approval</h2>
        {p.approvals.length === 0 ? <p className="muted">No decisions yet. Needs a tech lead sign-off and one stakeholder approval.</p> : (
          <div className="table-wrap"><table className="proj-table"><thead><tr><th scope="col">Who</th><th scope="col">As</th><th scope="col">Decision</th><th scope="col">Comment</th><th scope="col" className="num">Date</th></tr></thead>
            <tbody>{p.approvals.map(a => <tr key={a.approverName + a.at}><td>{a.approverName}</td><td>{label(a.role)}</td><td>{label(a.decision)}</td><td>{a.comments}</td><td className="num">{a.at.slice(0, 10)}</td></tr>)}</tbody></table></div>
        )}
        {p.status === "pending_approval" && <p className="muted">Still needed: {[p.needs.techLead ? "tech lead sign-off" : "", p.needs.stakeholder ? "a stakeholder approval" : ""].filter(Boolean).join(" and ") || "nothing"}.</p>}
        {mayDecide && roles.length > 0 && (
          <form className="proj-form" onSubmit={async e => { e.preventDefault(); const as = roles.includes(dec.as) ? dec.as : roles[0]!; const d = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value"); if (await send({ action: "decide", as, decision: d, comments: dec.comments }, d === "approved" ? "Approved." : "Rejected.")) setDec({ ...dec, comments: "" }); }}>
            <label>Decide as<select value={roles.includes(dec.as) ? dec.as : roles[0]} onChange={e => setDec({ ...dec, as: e.target.value })}>{roles.map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label>
            <label>Comment (at least 10 characters)<textarea required minLength={10} maxLength={1000} rows={3} value={dec.comments} onChange={e => setDec({ ...dec, comments: e.target.value })} /></label>
            <div className="proj-inline"><button type="submit" value="approved">Approve</button><button type="submit" value="rejected">Reject</button></div>
          </form>
        )}
      </section>

      <section className="proj-section"><h2>Milestones</h2>
        {p.milestones.length === 0 ? <p className="empty">No milestones yet.</p> : (
          <div className="table-wrap"><table className="proj-table"><thead><tr><th scope="col">Phase</th><th scope="col">Milestone</th><th scope="col" className="num">Target</th><th scope="col" className="num">Done</th></tr></thead>
            <tbody>{p.milestones.map(m => <tr key={m.id}><td>{label(m.phase)}</td><td>{m.description}</td><td className="num">{m.targetDate}</td>
              <td className="num">{m.actualDate ?? (editable && live ? <button type="button" onClick={() => send({ action: "milestone_done", id: m.id, actualDate: new Date().toISOString().slice(0, 10) }, "Milestone done.")}>Mark done</button> : "–")}</td></tr>)}</tbody></table></div>
        )}
        {editable && (
          <form className="proj-inline" onSubmit={async e => { e.preventDefault(); if (await send({ action: "milestone_add", ...ms }, "Milestone added.")) setMs({ ...ms, description: "" }); }}>
            <label>Phase<select value={ms.phase} onChange={e => setMs({ ...ms, phase: e.target.value })}>{PHASES.map(x => <option key={x} value={x}>{label(x)}</option>)}</select></label>
            <label>Milestone<input required minLength={3} maxLength={300} value={ms.description} onChange={e => setMs({ ...ms, description: e.target.value })} /></label>
            <label>Target date<input type="date" required value={ms.targetDate} onChange={e => setMs({ ...ms, targetDate: e.target.value })} /></label>
            <button type="submit">Add milestone</button>
          </form>
        )}
      </section>

      <section className="proj-section"><h2>Features</h2>
        <p className="muted">{p.featureLine}</p>
        {p.featureList.length > 0 && (
          <div className="table-wrap"><table className="proj-table"><thead><tr><th scope="col">Feature</th><th scope="col">Status</th></tr></thead>
            <tbody>{p.featureList.map(x => <tr key={x.id}><td>{x.name}</td><td>{editable && live ? <select aria-label={`Status of ${x.name}`} value={x.status} onChange={e => send({ action: "feature_status", id: x.id, status: e.target.value as FeatureStatus }, "Feature updated.")}>{FEATURE_STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select> : label(x.status)}</td></tr>)}</tbody></table></div>
        )}
        {editable && <form className="proj-inline" onSubmit={async e => { e.preventDefault(); if (await send({ action: "feature_add", name: feat }, "Feature added.")) setFeat(""); }}>
          <label>Feature<input required minLength={2} maxLength={160} value={feat} onChange={e => setFeat(e.target.value)} /></label><button type="submit">Add feature</button></form>}
      </section>

      <section className="proj-section"><h2>Pull requests</h2>
        {p.prList.length === 0 ? <p className="empty">No PRs linked. Link a PR by its number so it shows here.</p> : (
          <div className="table-wrap"><table className="proj-table"><thead><tr><th scope="col" className="num">PR</th><th scope="col">Title</th><th scope="col">Status</th></tr></thead>
            <tbody>{p.prList.map(x => <tr key={x.prNumber}><td className="num">#{x.prNumber}</td><td>{x.title}</td><td>{editable && live ? <select aria-label={`Status of PR ${x.prNumber}`} value={x.status} onChange={e => send({ action: "pr_status", prNumber: x.prNumber, status: e.target.value as PrStatus }, "PR updated.")}>{PR_STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select> : label(x.status)}</td></tr>)}</tbody></table></div>
        )}
        {editable && live && <form className="proj-inline" onSubmit={async e => { e.preventDefault(); if (await send({ action: "pr_link", prNumber: Number(pr.prNumber), title: pr.title, status: pr.status }, "PR linked.")) setPr({ ...pr, prNumber: "", title: "" }); }}>
          <label>PR number<input type="number" required min={1} value={pr.prNumber} onChange={e => setPr({ ...pr, prNumber: e.target.value })} /></label>
          <label>Title<input required maxLength={200} value={pr.title} onChange={e => setPr({ ...pr, title: e.target.value })} /></label>
          <label>Status<select value={pr.status} onChange={e => setPr({ ...pr, status: e.target.value })}>{PR_STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></label>
          <button type="submit">Link PR</button></form>}
      </section>

      {editable && (
        <section className="proj-section"><h2>Progress and blockers</h2>
          {p.blockedReason && <p role="status"><strong>Blocked:</strong> {p.blockedReason}</p>}
          <form className="proj-inline" onSubmit={async e => { e.preventDefault(); const kind = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value"); if (await send(kind === "block" ? { action: "block", reason: text } : { action: "note", note: text }, kind === "block" ? "Blocker recorded." : "Progress noted.")) setText(""); }}>
            <label>Note or blocker<input required minLength={3} maxLength={500} value={text} onChange={e => setText(e.target.value)} /></label>
            <button type="submit" value="note">Log progress</button>{live && <button type="submit" value="block">Mark blocked</button>}
          </form>
          <div className="proj-inline">
            {p.blockedReason && <button type="button" onClick={() => send({ action: "unblock" }, "Unblocked.")}>Clear blocker</button>}
            {live && <button type="button" onClick={() => send({ action: "set_status", status: "on_hold" }, "Put on hold.")}>Put on hold</button>}
            {p.status === "on_hold" && <button type="button" onClick={() => send({ action: "set_status", status: "active" }, "Resumed.")}>Resume</button>}
            {live && <button type="button" onClick={() => send({ action: "set_status", status: "completed" }, "Marked completed.")}>Mark completed</button>}
          </div>
        </section>
      )}
    </main>
  );
}
