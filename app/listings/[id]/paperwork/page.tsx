"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { PaperGroup, PaperItem, PaperSummary } from "../../../../src/domain/sale-paperwork";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/elena-offers.css";

type Log = { id: string; party: string; kind: string; body: string; status: string; reason?: string; at: string };
type Chase = { party: string; state: string; reminders: number; nextActionAt: string };
type View = { items: PaperItem[]; summary: PaperSummary; saleInProgress: boolean; chase: boolean; chases: Chase[]; log: Log[]; note: string; canChange: boolean };

const GROUPS: PaperGroup[] = ["Disclosures", "Deposit", "Contract", "Reports", "Identity", "Settlement steps"];
const MARK: Record<string, string> = { done: "✓", open: "○", in_progress: "◐", upcoming: "·" };
const STATUS: Record<string, string> = { done: "Complete", open: "Missing", in_progress: "In progress", upcoming: "Later step" };
const PARTY: Record<string, string> = { owner: "You", buyer: "The buyer", staff: "Compliance staff", agent: "Your agent" };
const BLOCKS: Record<string, string> = { publish: "Blocks listing", settlement: "Blocks settlement" };
const LOG_STATUS: Record<string, string> = { sent: "Sent", blocked: "Blocked by safety filter", rate_limited: "Held back (daily limit)", failed: "Not delivered" };
const when = (iso: string) => new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/**
 * The paperwork checklist for one listing. Items come from rules the platform already has. Elena shows what is complete and what blocks, and can
 * chase the people who owe something, by message, until it is done. Workflow help, not legal advice.
 */
export default function Paperwork() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/listings/${id}/paperwork`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setV(d); setError(""); } else setError(r.status === 401 ? "Sign in to see the paperwork." : r.status === 404 ? "Listing not found." : r.status === 429 ? "Too many requests. Try again in a while." : d.error ?? "Could not load the paperwork.");
    } catch { setError("Could not load the paperwork."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function setChase(chase: boolean) {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${id}/paperwork`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ chase }) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not save that."); else await load();
    } catch { setError("Could not save that."); } finally { setBusy(false); }
  }

  const pct = v && v.summary.total > 0 ? Math.round((v.summary.done / v.summary.total) * 100) : 0;
  return (
    <main className="pw">
      <h1>Sale paperwork</h1>
      <p>What is done, what is missing and what stands in the way. Elena can remind the people who owe something, and stops when it is done.</p>
      {error ? <p role="alert" className="cmp-err">{error}</p> : null}
      {!error && v === null ? <p className="muted" role="status">Loading the checklist…</p> : null}
      {v ? (
        <>
          <section className="pw-head" aria-labelledby="pw-sum">
            <h2 id="pw-sum">{v.summary.headline}</h2>
            <div className="pw-bar" role="progressbar" aria-valuemin={0} aria-valuemax={v.summary.total} aria-valuenow={v.summary.done} aria-label="Paperwork complete"><span style={{ width: `${pct}%` }} /></div>
            <p className="muted">{v.summary.done} of {v.summary.total} items complete{v.saleInProgress ? "" : ". Settlement steps appear once you accept an offer and start the settlement tracker."}</p>
          </section>

          {v.items.length === 0 ? <p className="empty">Nothing to track yet.</p> : null}
          {GROUPS.map(g => {
            const items = v.items.filter(i => i.group === g);
            if (items.length === 0) return null;
            return (
              <section className="pw-group" key={g} aria-labelledby={`pw-${g.replace(/\s/g, "")}`}>
                <h2 id={`pw-${g.replace(/\s/g, "")}`}>{g}</h2>
                <ul className="pw-list">
                  {items.map(i => (
                    <li key={i.key} className={`pw-item is-${i.status}`}>
                      <span className="pw-mark" aria-hidden="true">{MARK[i.status]}</span>
                      <div>
                        <strong>{i.label}</strong>
                        <div className="pw-meta">
                          <span>{STATUS[i.status]}</span>
                          {i.status !== "done" ? <span>· {PARTY[i.party]} to provide</span> : null}
                          {i.status !== "done" && i.blocks !== "none" ? <span className="pw-tag block">{BLOCKS[i.blocks]}</span> : null}
                          {i.status !== "done" && i.blocks === "none" ? <span className="pw-tag">Recommended</span> : null}
                        </div>
                        {i.detail && i.status !== "done" ? <p className="muted">{i.detail}</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <section className="panel" aria-labelledby="pw-chase-h">
            <h2 id="pw-chase-h">Let Elena chase it</h2>
            <p className="muted">Once a sale is under way, Elena reminds you and the buyer about your own open items: at most one message a day each, three in all, then she stops and tells you. She never sends amounts or contact details, and never shares your list with the buyer or theirs with you.</p>
            <label className="check"><input type="checkbox" checked={v.chase} disabled={busy || !v.canChange} onChange={e => void setChase(e.target.checked)} /> Elena may send paperwork reminders for this listing</label>
            {!v.canChange ? <p className="muted">Only the owner can change this.</p> : null}
            {v.chases.map(c => <p className="muted" key={c.party}>{c.party === "owner" ? "You" : "Buyer"}: {c.state === "active" ? `${c.reminders} of 3 reminders sent, next ${when(c.nextActionAt)}` : c.state === "done" ? "everything on that side is complete" : "Elena has stopped after 3 reminders"}</p>)}
          </section>

          {v.log.length > 0 ? (
            <section aria-labelledby="pw-log-h">
              <h2 id="pw-log-h">What Elena has sent</h2>
              <ul className="pw-log">{v.log.map(l => <li key={l.id}><time dateTime={l.at}>{when(l.at)} · to {l.party === "owner" ? "you" : "the buyer"} · {LOG_STATUS[l.status] ?? l.status}</time><pre>{l.body}</pre>{l.reason ? <small className="muted">{l.reason}</small> : null}</li>)}</ul>
            </section>
          ) : null}

          <p className="pw-note">{v.note}</p>
          <p><a href={`/listings/${id}/offers`}>Back to offers</a></p>
        </>
      ) : null}
    </main>
  );
}
