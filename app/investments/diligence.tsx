"use client";
import { useCallback, useEffect, useState } from "react";
import type { DiligenceFlag, DiligenceSummary } from "../../src/domain/elena-diligence";
import { send } from "./ui";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const SEV: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

export interface DView { id: string; status: "draft" | "published"; summary: DiligenceSummary; developerNote: string; approvedAt?: string; createdAt: string; outdated: boolean; notice: string }

function Flags({ title, items, empty }: { title: string; items: DiligenceFlag[]; empty: string }) {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? <p className="muted inv-small">{empty}</p> : (
        <ul className="elena-list">{items.map(f => <li key={f.id} className={`elena-flag ${f.severity}`}><strong>{f.title}</strong><p className="elena-a">{f.detail}</p><span className="muted inv-small">Priority: {SEV[f.severity]}</span></li>)}</ul>
      )}
    </>
  );
}

/** The summary itself, the same for the developer's preview and for investors. */
export function DiligenceReport({ d }: { d: DView }) {
  const s = d.summary;
  return (
    <div className="dd-report">
      {d.outdated && <p className="elena-notice dd-outdated" role="status">The project's documents have changed since this summary was written, so parts of it may be out of date.</p>}
      <p className="elena-a"><strong>{s.headline}</strong></p>
      {d.developerNote && <blockquote className="elena-src"><strong>The developer's note</strong><br />{d.developerNote}<cite>Written by the developer, not by Elena</cite></blockquote>}

      <h3>What the documents say</h3>
      {s.documents.length === 0 ? <p className="muted inv-small">Elena has not read any documents yet.</p> : (
        <ul className="elena-list">{s.documents.map(doc => (
          <li key={doc.id}>
            <strong>{doc.title}</strong>
            {doc.readable ? doc.points.map((p, i) => <blockquote key={i} className="elena-src">“{p}”<cite>{doc.title}</cite></blockquote>) : <p className="muted inv-small">Elena could not read the text in this document.</p>}
          </li>
        ))}</ul>
      )}

      <h3>Risks to check</h3>
      {s.risks.length === 0 ? <p className="muted inv-small">Elena did not find wording about risk in the documents she read. That does not mean there is no risk.</p> : (
        <ul className="elena-list">{s.risks.map(r => (
          <li key={r.id} className={`elena-flag ${r.severity}`}>
            <strong>{r.title}</strong>
            {r.quote && <blockquote className="elena-src">“{r.quote}”<cite>{r.cite.title}{r.cite.page ? `, page ${r.cite.page}` : ""}</cite></blockquote>}
            {!r.quote && <span className="muted inv-small">{r.cite.title}{r.cite.page ? `, page ${r.cite.page}` : ""}</span>}
          </li>
        ))}</ul>
      )}
      <Flags title="Possible inconsistencies" items={s.inconsistencies.map(i => ({ id: i.id, severity: i.severity, title: i.title, detail: i.detail }))} empty="Elena did not find figures that disagree. She only compares a few labelled figures, so check the rest yourself." />
      <Flags title="Missing or out-of-date documents" items={s.missing} empty="Nothing obvious is missing for this stage." />
      {s.notRead.length > 0 && <Flags title="Not covered by this summary" items={s.notRead} empty="" />}
      <p className="muted inv-small">Written {when(d.createdAt)}{d.approvedAt ? `, approved by the developer ${when(d.approvedAt)}` : ""}.</p>
      <p className="elena-notice" role="note"><strong>AI-generated, not advice.</strong> {d.notice}</p>
    </div>
  );
}

/** Investors: the latest summary the developer approved, if any. */
export function InvestorDiligence({ projectId }: { projectId: string }) {
  const [d, setD] = useState<DView | null | undefined>(undefined);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    fetch(`/api/investments/projects/${projectId}/elena/diligence`).then(async r => {
      if (!live) return;
      if (!r.ok) { setErr("Could not load the due-diligence summary."); setD(null); return; }
      setD(((await r.json()) as { published?: DView }).published ?? null);
    }).catch(() => { if (live) { setErr("Could not load the due-diligence summary."); setD(null); } });
    return () => { live = false; };
  }, [projectId]);
  return (
    <section className="panel elena-box" aria-labelledby="dd-h" id="due-diligence">
      <h2 id="dd-h">Elena's due-diligence summary</h2>
      {d === undefined && <p className="muted" role="status">Loading…</p>}
      {err && <p role="alert">{err}</p>}
      {d === null && !err && <p className="muted" role="status">The developer has not published a due-diligence summary yet. You can still ask Elena questions below.</p>}
      {d && <DiligenceReport d={d} />}
    </section>
  );
}

/** Developer: Elena writes a draft only they can see; they add a note, read it and approve it. */
export function OwnerDiligence({ projectId }: { projectId: string }) {
  const base = `/api/investments/projects/${projectId}/elena/diligence`;
  const [data, setData] = useState<{ draft?: DView; published?: DView } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const r = await fetch(base).catch(() => null);
    if (!r || !r.ok) { setError("Could not load the due-diligence summary."); setData({}); return; }
    const j = (await r.json()) as { draft?: DView; published?: DView };
    setData(j); setNote(j.draft?.developerNote ?? "");
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  async function act(fn: () => Promise<{ ok: boolean; data: Record<string, unknown> }>, done: string) {
    setBusy(true); setMsg(""); setError("");
    const r = await fn();
    setBusy(false);
    if (r.ok) { setMsg(done); await load(); } else setError(String(r.data["error"] ?? "That did not work."));
  }
  const draft = data?.draft, pub = data?.published;
  return (
    <section className="panel elena-box" aria-labelledby="odd-h">
      <h2 id="odd-h">Due-diligence summary for investors</h2>
      <p className="muted inv-small">Elena reads the documents investors can see and writes a plain-English summary with the risks, missing documents and figures that disagree. It is labelled AI-generated and not advice. Investors see nothing until you approve it. Documents still waiting for masking review are not read.</p>
      {msg && <p role="status" className="inv-visitor">{msg}</p>}
      {error && <p role="alert" className="inv-visitor">{error}</p>}
      <p className="elena-actions"><button type="button" onClick={() => act(() => send(base, "POST", {}), "Elena wrote a draft. Read it before you approve it.")} disabled={busy}>{busy ? "Elena is reading…" : draft ? "Ask Elena to read the documents again" : "Ask Elena to write a summary"}</button></p>
      {!data && <p className="muted" role="status">Loading…</p>}
      {draft && (
        <>
          <span className="elena-tag draft">Draft, only you can see it</span>
          <DiligenceReport d={{ ...draft, developerNote: note }} />
          <div className="elena-edit">
            <label htmlFor="dd-note">Your note to investors (optional, shown as yours)</label>
            <textarea id="dd-note" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} />
            <div className="elena-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => act(() => send(`${base}/${draft.id}/note`, "PUT", { note }), "Note saved.")}>Save note</button>
              <button type="button" disabled={busy || note !== draft.developerNote} onClick={() => act(() => send(`${base}/${draft.id}/publish`, "POST", {}), "Approved. Investors can now read this summary.")}>Approve and publish</button>
            </div>
            {note !== draft.developerNote && <p className="muted inv-small">Save your note before approving.</p>}
            <p className="muted inv-small">Read every line first. You are approving what investors will see; Elena's findings can be wrong.</p>
          </div>
        </>
      )}
      {pub && (
        <details>
          <summary>Published summary (what investors see now{pub.outdated ? ", documents have changed since" : ""})</summary>
          <DiligenceReport d={pub} />
        </details>
      )}
    </section>
  );
}
