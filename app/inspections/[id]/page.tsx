"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { defaultLocal, FOLLOWUP_LABELS, formatWhen, JSON_HEADERS, localToIso, ROLE_LABELS, SEVERITY_LABELS, STATUS_LABELS, TYPE_LABELS } from "../ui";

type Finding = { id: string; area: string; title: string; detail: string; severity: string; followupStatus: string; followupNote: string; photoIds: string[] };
type Flag = { findingId: string; title: string; severity: string; reason: string; topics: string[] };
type Report = {
  role: "manager" | "inspector" | "viewer";
  inspection: {
    id: string; type: string; scheduledAt: string; notes: string; status: string; listingTitle: string; inspectorName: string;
    summary?: { text: string; source: "ai" | "rules"; approved: boolean };
  };
  findings: Finding[]; counts: Record<string, number>; flags: Flag[]; openFollowUps: number;
  shares?: { id: string; name: string; sharedAt: string }[]; photoLimitReached: boolean;
};

const RANK: Record<string, number> = { critical: 0, major: 1, moderate: 2, minor: 3, info: 4 };

export default function InspectionPage() {
  const { id } = useParams<{ id: string }>();
  const [rep, setRep] = useState<Report | null>(null);
  const [loadError, setLoadError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/inspections/${id}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setRep(d);
      else setLoadError(r.status === 401 ? "Sign in to see this inspection." : r.status === 404 ? "Inspection not found." : d.error ?? "Could not load this inspection.");
    } catch { setLoadError("Could not load this inspection."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: unknown, ok?: string) {
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`/api/inspections/${id}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.error ?? "That did not work. Try again."); return false; }
      if (ok) setMsg(ok);
      await load();
      return true;
    } catch { setMsg("That did not work. Check your connection and try again."); return false; }
    finally { setBusy(false); }
  }

  if (loadError) return <main className="insp-page"><p><a href="/inspections">All inspections</a></p><p role="alert">{loadError}</p></main>;
  if (!rep) return <main className="insp-page"><p className="muted" role="status">Loading…</p></main>;

  const { inspection: i, role } = rep;
  const sorted = [...rep.findings].sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
  const isInspector = role === "inspector", isManager = role === "manager";

  return (
    <main className="insp-page">
      <p><a href="/inspections">All inspections</a></p>
      <div className="insp-head">
        <h1>{i.listingTitle}</h1>
        <p className="insp-meta">
          <span>{TYPE_LABELS[i.type] ?? i.type}</span><span>{formatWhen(i.scheduledAt)}</span>
          <span className="badge">{STATUS_LABELS[i.status] ?? i.status}</span><span>{ROLE_LABELS[role]}</span>
          {!isInspector && <span>Inspector: {i.inspectorName}</span>}
        </p>
      </div>
      <p role="status" aria-live="polite">{msg}</p>

      {i.notes && (isInspector || isManager) && <section className="insp-panel"><h2>Notes for the inspector</h2><p>{i.notes}</p></section>}

      {isInspector && i.status === "invited" && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void post("", { action: "accept" })}>Accept this job</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void post("", { action: "decline" })}>Decline</button>
        </div>
      )}

      {rep.flags.length > 0 && (
        <section className="insp-panel insp-critical" aria-labelledby="flags-h">
          <h2 id="flags-h">Serious issues to check first</h2>
          <ul>
            {rep.flags.map(f => (
              <li key={f.findingId}>
                <a href={`#f-${f.findingId}`}>{f.title}</a> <span className={`insp-sev sev-${f.severity}`}>{SEVERITY_LABELS[f.severity]}</span>
                {f.reason === "wording" && <span className="muted"> · rated {SEVERITY_LABELS[f.severity]?.toLowerCase()}, but the notes mention {f.topics.join(", ")}: check the rating</span>}
              </li>
            ))}
          </ul>
          <p className="muted">Flagged by rule from the inspector's ratings and words. Follow serious issues up with a licensed tradesperson.</p>
        </section>
      )}

      {(rep.findings.length > 0 || i.summary) && (
        <section className="insp-panel" aria-labelledby="sum-h">
          <h2 id="sum-h">Elena's summary</h2>
          {i.summary ? (
            <>
              <p className="insp-summary-text">{i.summary.text}</p>
              <p className="muted">{i.summary.source === "ai" ? "Written by Elena (AI)." : "Built from the findings; the AI is off."} {i.summary.approved ? "Approved by a person." : "Not yet approved, so shared viewers cannot see it."}</p>
            </>
          ) : <p className="muted">No summary yet.</p>}
          {!rep.flags.length && rep.findings.length > 0 && !i.summary && <p className="muted">Elena can summarise the findings in plain English.</p>}
          {role !== "viewer" && rep.findings.length > 0 && (
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => void post("/summary", { action: "generate" }, "Summary written. Read it before approving.")}>{i.summary ? "Write it again" : "Ask Elena to summarise"}</button>
              {i.summary && !i.summary.approved && <button type="button" disabled={busy} onClick={() => void post("/summary", { action: "approve" }, "Summary approved.")}>Approve summary</button>}
            </div>
          )}
        </section>
      )}

      <section className="insp-panel" aria-labelledby="find-h">
        <h2 id="find-h">Findings ({rep.findings.length})</h2>
        <div className="insp-counts" aria-label="Findings by severity">
          {Object.keys(RANK).filter(s => (rep.counts[s] ?? 0) > 0).map(s => <span key={s} className={`insp-sev sev-${s}`}>{rep.counts[s]} {SEVERITY_LABELS[s]}</span>)}
        </div>
        {rep.findings.length === 0 && <p className="empty">{isInspector ? "No findings yet. Add the first one below." : "No findings have been recorded yet."}</p>}
        <ul className="insp-findings">
          {sorted.map(f => (
            <li key={f.id} id={`f-${f.id}`} className="insp-finding">
              <span className={`insp-sev sev-${f.severity}`}>{SEVERITY_LABELS[f.severity]}</span>
              <h3>{f.title}</h3>
              <span className="area">{f.area}</span>
              {f.detail && <p>{f.detail}</p>}
              {f.photoIds.length > 0 && (
                <div className="insp-photos">
                  {f.photoIds.map((p, n) => (
                    <a key={p} href={`/api/inspections/${id}/photos/${p}`} target="_blank" rel="noopener noreferrer">
                      <img src={`/api/inspections/${id}/photos/${p}`} alt={`Photo ${n + 1} of ${f.photoIds.length}: ${f.area}, ${f.title}`} loading="lazy" width={88} height={88} />
                    </a>
                  ))}
                </div>
              )}
              {f.followupStatus !== "none" && (isManager && i.status === "completed"
                ? <FollowUp finding={f} busy={busy} onSave={(status, note) => post(`/findings/${f.id}`, { status, note }, "Follow-up saved.")} />
                : <p className="muted">Follow-up: {FOLLOWUP_LABELS[f.followupStatus]}{f.followupNote ? ` · ${f.followupNote}` : ""}</p>)}
            </li>
          ))}
        </ul>
      </section>

      {isInspector && i.status === "accepted" && (
        <>
          <AddFinding busy={busy} id={id} photoLimitReached={rep.photoLimitReached} onDone={async m => { setMsg(m); await load(); }} />
          <div className="actions">
            <button type="button" disabled={busy || rep.findings.length === 0} onClick={() => { if (window.confirm("Complete the report? Findings and photos cannot be changed afterwards.")) void post("", { action: "complete" }, "Report completed."); }}>Complete the report</button>
          </div>
        </>
      )}

      {isManager && (
        <ManagerTools rep={rep} busy={busy} post={post} />
      )}
    </main>
  );
}

function FollowUp({ finding, busy, onSave }: { finding: Finding; busy: boolean; onSave: (status: string, note: string) => Promise<boolean> }) {
  const [status, setStatus] = useState(finding.followupStatus);
  const [note, setNote] = useState(finding.followupNote);
  return (
    <form className="insp-followup" onSubmit={e => { e.preventDefault(); void onSave(status, note); }}>
      <div className="row">
        <label>Follow-up status
          <select value={status} onChange={e => setStatus(e.target.value)}>
            {["open", "in_progress", "resolved", "wont_fix"].map(s => <option key={s} value={s}>{FOLLOWUP_LABELS[s]}</option>)}
          </select>
        </label>
        <label>Note (who is fixing it, when)
          <input value={note} onChange={e => setNote(e.target.value)} maxLength={1000} />
        </label>
        <button type="submit" className="secondary" disabled={busy}>Save</button>
      </div>
    </form>
  );
}

function AddFinding({ id, busy, photoLimitReached, onDone }: { id: string; busy: boolean; photoLimitReached: boolean; onDone: (msg: string) => Promise<void> }) {
  const [area, setArea] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [severity, setSeverity] = useState("moderate");
  const [files, setFiles] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setWorking(true); setError("");
    try {
      const r = await fetch(`/api/inspections/${id}/findings`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ area, title, detail, severity }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "Could not save the finding."); return; }
      let failed = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("findingId", d.finding.id);
        try {
          const pr = await fetch(`/api/inspections/${id}/photos`, { method: "POST", body: fd });
          if (!pr.ok) failed += 1;
        } catch { failed += 1; }
      }
      setTitle(""); setDetail(""); setFiles([]);
      (e.target as HTMLFormElement).reset();
      await onDone(failed > 0 ? `Finding saved. ${failed} photo${failed === 1 ? "" : "s"} could not be added; the finding is recorded without them.` : "Finding saved.");
    } catch { setError("Could not save the finding. Check your connection and try again."); }
    finally { setWorking(false); }
  }

  return (
    <form className="insp-form two insp-panel" onSubmit={submit}>
      <h2 className="wide">Add a finding</h2>
      <label>Area (for example Kitchen, Roof)
        <input value={area} onChange={e => setArea(e.target.value)} required maxLength={80} />
      </label>
      <label>Severity
        <select value={severity} onChange={e => setSeverity(e.target.value)}>
          {Object.entries(SEVERITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="wide">What you found (short title)
        <input value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} />
      </label>
      <label className="wide">Details
        <textarea value={detail} onChange={e => setDetail(e.target.value)} maxLength={2000} />
      </label>
      <label className="wide">Photos (up to 6, taken now or from your gallery)
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple disabled={photoLimitReached}
          onChange={e => setFiles(Array.from(e.target.files ?? []).slice(0, 6))} />
      </label>
      {photoLimitReached && <p className="muted wide">This report has reached its photo limit.</p>}
      <p className="muted wide">Findings cannot be edited once saved. If something was wrong, add a corrected finding.</p>
      <button type="submit" className="wide" disabled={busy || working}>{working ? "Saving…" : "Save finding"}</button>
      {error && <p role="alert" className="wide">{error}</p>}
    </form>
  );
}

function ManagerTools({ rep, busy, post }: { rep: Report; busy: boolean; post: (path: string, body: unknown, ok?: string) => Promise<boolean> }) {
  const [when, setWhen] = useState(defaultLocal);
  const [contact, setContact] = useState("");
  const status = rep.inspection.status;
  return (
    <>
      {(status === "invited" || status === "accepted") && (
        <section className="insp-panel" aria-labelledby="mg-h">
          <h2 id="mg-h">Change the booking</h2>
          <form className="insp-form" onSubmit={e => { e.preventDefault(); void post("", { action: "reschedule", scheduledAt: localToIso(when) }, "Booking moved. The inspector needs to accept again."); }}>
            <label>New date and time
              <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} required />
            </label>
            <button type="submit" className="secondary" disabled={busy}>Reschedule</button>
          </form>
          <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={() => { if (window.confirm("Cancel this inspection?")) void post("", { action: "cancel" }, "Inspection cancelled."); }}>Cancel the inspection</button></div>
        </section>
      )}
      {status === "completed" && (
        <section className="insp-panel" aria-labelledby="sh-h">
          <h2 id="sh-h">Share this report</h2>
          <p className="muted">Share with a buyer, the seller or an agent who has an account. They see the findings, photos and flags, and Elena's summary once you approve it.</p>
          {rep.shares && rep.shares.length === 0 && <p className="muted">Not shared with anyone yet.</p>}
          <ul className="insp-share-list">
            {rep.shares?.map(s => (
              <li key={s.id}><span>{s.name} · {formatWhen(s.sharedAt)}</span>
                <button type="button" className="secondary" disabled={busy} onClick={() => void post(`/shares/${s.id}`, {}, "Sharing stopped.")}>Stop sharing</button></li>
            ))}
          </ul>
          <form className="insp-form" onSubmit={async e => { e.preventDefault(); if (await post("/shares", contact.includes("@") ? { email: contact.trim() } : { userId: contact.trim() }, "Report shared.")) setContact(""); }}>
            <label>Their email or user id
              <input value={contact} onChange={e => setContact(e.target.value)} required maxLength={254} autoComplete="off" />
            </label>
            <button type="submit" disabled={busy}>Share report</button>
          </form>
        </section>
      )}
    </>
  );
}
