"use client";
import { use, useCallback, useEffect, useState } from "react";
import { dateLabel, STAGE_LABEL, STAGES, type Stage } from "../../../src/domain/settlement";
import { RiskPanel, type RiskData } from "../risk-panel";
import "../../styles/offers.css";
import "../../styles/settlement.css";

interface Item { id: string; label: string; done: boolean; canTick: boolean }
interface View {
  id: string; listingTitle: string; side: "buyer" | "seller" | "agent"; currentStage: Stage; completed: boolean; fellThrough: boolean; canUpdate: boolean;
  stuck: { stuck: boolean; days: number; blocked: boolean };
  milestones: { stage: Stage; status: "pending" | "completed" | "blocked"; targetDate: string | null; actualDate: string | null; note: string | null }[];
  checklists: { stage: Stage; role: "buyer" | "seller" | "agent" | "lawyer"; items: Item[] }[];
}
const ROLE: Record<string, string> = { buyer: "Buyer", seller: "Seller", agent: "Agent", lawyer: "Solicitors" };

/** One settlement's timeline: the eight stages, their dates and the checklist items for each side. The owner or agent moves it along. */
export default function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [risk, setRisk] = useState<RiskData | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/settlements/${id}`).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) {
      setV(d as View); setError("");
      // Risk advice is for the owner and agent only (the buyer gets a 403 and sees nothing).
      const rr = await fetch(`/api/settlements/${id}/risk`).catch(() => null);
      setRisk(rr?.ok ? ((await rr.json().catch(() => null)) as RiskData | null) : null);
    } else setError(r?.status === 401 ? "Sign in to see this settlement." : r?.status === 404 ? "Settlement not found." : "Could not load this settlement.");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function send(body: Record<string, unknown>) {
    setBusy(true); setError("");
    const r = await fetch(`/api/settlements/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (r && !r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
    else if (!r) setError("Network error.");
    else setNote("");
    setBusy(false);
    await load();
  }

  if (error && !v) return <main><p role="alert">{error}</p><p><a href="/settlements">Back to settlements</a></p></main>;
  if (!v) return <main><p className="muted" role="status">Loading…</p></main>;
  return (
    <main>
      <p><a href="/settlements">Back to settlements</a> · <a href={`/messages/${v.id}`}>Messages for this sale</a></p>
      <h1>{v.listingTitle}</h1>
      <p className="muted">{v.fellThrough ? "This sale fell through, so the timeline is closed." : v.completed ? "Settled." : v.canUpdate ? "You can complete stages and tick the owner, agent and solicitor items." : "You can tick your own items. The owner or agent completes each stage."}</p>
      {v.stuck.stuck ? <p role="status" className="ai-note"><strong>{v.stuck.blocked ? "This stage is blocked." : `This stage has been open ${v.stuck.days} days.`}</strong> Check what is holding it up.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {risk && !v.completed && !v.fellThrough ? <RiskPanel r={risk} who="party" /> : null}
      <ol className="settle-steps">
        {STAGES.map(stage => {
          const m = v.milestones.find(x => x.stage === stage)!;
          const lists = v.checklists.filter(c => c.stage === stage);
          const isCurrent = !v.completed && !v.fellThrough && stage === v.currentStage;
          return (
            <li key={stage} className={`settle-step is-${m.status === "pending" && isCurrent ? "current" : m.status}`}>
              <h3>{STAGE_LABEL[stage]} <span className={`badge ${m.status === "completed" ? "badge-done" : m.status === "blocked" ? "badge-stuck" : ""}`}>{m.status === "completed" ? "Done" : m.status === "blocked" ? "Blocked" : isCurrent ? "In progress" : "Upcoming"}</span></h3>
              <dl className="settle-dates">
                {m.targetDate ? <div><dt>Target</dt><dd>{dateLabel(m.targetDate)}</dd></div> : null}
                {m.actualDate ? <div><dt>Completed</dt><dd>{dateLabel(m.actualDate)}</dd></div> : null}
              </dl>
              {m.note ? <p className="muted">{m.note}</p> : null}
              {lists.map(c => (
                <fieldset key={c.role} className="settle-check-group">
                  <legend>{ROLE[c.role]}</legend>
                  <ul className="settle-check">
                    {c.items.map(i => (
                      <li key={i.id}><label><input type="checkbox" checked={i.done} disabled={!i.canTick || busy} onChange={e => void send({ action: "tick", stage, role: c.role, itemId: i.id, done: e.target.checked })} /> {i.label}</label></li>
                    ))}
                  </ul>
                </fieldset>
              ))}
              {v.canUpdate && m.status !== "completed" ? (
                <div className="settle-actions">
                  <label>Target date<input type="date" defaultValue={m.targetDate ?? ""} disabled={busy} onChange={e => e.target.value && void send({ action: "milestone", stage, targetDate: e.target.value })} /></label>
                  {isCurrent ? (
                    <>
                      <button type="button" disabled={busy} onClick={() => void send({ action: "milestone", stage, status: "completed" })}>Mark complete</button>
                      {m.status === "blocked"
                        ? <button type="button" className="secondary" disabled={busy} onClick={() => void send({ action: "milestone", stage, status: "pending" })}>Unblock</button>
                        : <>
                            <label>What is blocking it?<input value={note} maxLength={500} onChange={e => setNote(e.target.value)} /></label>
                            <button type="button" className="secondary" disabled={busy || !note.trim()} onClick={() => void send({ action: "milestone", stage, status: "blocked", note })}>Mark blocked</button>
                          </>}
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
