"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ReviewFlag } from "../../../../src/domain/elena-projects";
import { QuestionCard, SourceList, UpdatesList, type QView, type UView } from "../../elena-project";
import { OwnerDiligence } from "../../diligence";
import { send } from "../../ui";

/** Owner screen: what Elena thinks is missing, her draft updates for approval, and the questions investors asked. */
export default function OwnerElena() {
  const { id } = useParams<{ id: string }>();
  const base = `/api/investments/projects/${id}`;
  const [flags, setFlags] = useState<ReviewFlag[] | null>(null);
  const [fresh, setFresh] = useState(0);
  const [updates, setUpdates] = useState<UView[] | null>(null);
  const [questions, setQuestions] = useState<QView[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id: string; title: string; body: string } | null>(null);
  const [reply, setReply] = useState<{ id: string; body: string } | null>(null);
  const [mode, setMode] = useState<"approve_first" | "instant">("approve_first");
  const [rev, setRev] = useState<{ id: string; body: string } | null>(null);

  const load = useCallback(async () => {
    const rs = await Promise.all([fetch(`${base}/elena/review`), fetch(`${base}/updates`), fetch(`${base}/elena/questions`)]).catch(() => null);
    if (!rs || rs.some(r => !r.ok)) { setError(rs?.some(r => r.status === 404) ? "This page is for the project owner." : "Could not load Elena's notes."); setFlags([]); setUpdates([]); setQuestions([]); return; }
    setError("");
    const rv = (await rs[0]!.json()) as { flags: ReviewFlag[]; newDocuments: number };
    setFlags(rv.flags); setFresh(rv.newDocuments);
    setUpdates(((await rs[1]!.json()) as { updates: UView[] }).updates);
    const qd = (await rs[2]!.json()) as { questions: QView[]; answerMode?: "approve_first" | "instant" };
    setQuestions(qd.questions); if (qd.answerMode) setMode(qd.answerMode);
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<{ ok: boolean; data: Record<string, unknown> }>, done: string) {
    setBusy(true); setMsg(""); setError("");
    const r = await fn();
    setBusy(false);
    if (r.ok) { setMsg(done); await load(); return true; }
    setError(String(r.data["error"] ?? "That did not work."));
    return false;
  }
  const draft = () => act(() => send(`${base}/elena/draft`, "POST", {}), "Elena wrote a draft. Read it, edit it and approve it when you are happy. Investors see nothing until then.");
  const publish = (uid: string) => act(() => send(`${base}/updates/${uid}/publish`, "POST", {}), "Published. Followers have been notified.");
  async function save() { if (edit && (await act(() => send(`${base}/updates/${edit.id}`, "PATCH", { title: edit.title, body: edit.body }), "Draft saved."))) setEdit(null); }
  async function sendReply() { if (reply && (await act(() => send(`${base}/elena/questions/${reply.id}/reply`, "POST", { body: reply.body }), "Reply sent."))) setReply(null); }

  const decide = (qid: string, decision: "approve" | "edit" | "discard", body?: string) =>
    act(() => send(`${base}/elena/questions/${qid}/review`, "POST", { decision, ...(body !== undefined ? { body } : {}) }),
      decision === "approve" ? "Approved. The investor can now read Elena's answer." : decision === "edit" ? "Your answer was sent to the investor." : "Discarded. Reply to the investor yourself when you are ready.");
  const changeMode = (m: "approve_first" | "instant") => act(() => send(`${base}/elena/settings`, "PUT", { answerMode: m }), m === "approve_first" ? "Elena will draft answers for you to approve." : "Elena will now answer straight away from your documents.");

  const drafts = (updates ?? []).filter(u => u.status === "draft");
  const published = (updates ?? []).filter(u => u.status === "published");
  const waiting = (questions ?? []).filter(q => q.state === "pending_owner");
  const open = (questions ?? []).filter(q => q.outcome === "escalated" && q.replies.length === 0);

  return (
    <main className="inv-detail">
      <p className="inv-back"><a href={`/investments/${id}`}>Back to project</a> · <a href={`/investments/${id}/documents`}>Manage documents</a></p>
      <h1>Elena: questions and updates</h1>
      <p className="muted">Elena answers investors only from what you publish, and passes on what she can't answer. She never promises returns, never shows the exact address and never commits anyone to anything. Nothing reaches investors until you approve it.</p>
      {msg && <p role="status" className="inv-visitor">{msg}</p>}
      {error && <p role="alert" className="inv-visitor">{error}</p>}

      <OwnerDiligence projectId={id} />

      <section className="panel elena-box" aria-labelledby="flags-h">
        <h2 id="flags-h">Keeping the project current</h2>
        {!flags ? <p className="muted" role="status">Loading…</p> : flags.length === 0 ? <p role="status">Nothing to fix. The documents look current for this stage.</p> : (
          <ul className="elena-list">{flags.map(f => (
            <li key={f.id} className={`elena-flag ${f.severity}`}><strong>{f.title}</strong><p className="elena-a">{f.detail}</p><span className="muted inv-small">Next step: {f.action}</span></li>
          ))}</ul>
        )}
      </section>

      <section className="panel elena-box" aria-labelledby="upd-h">
        <h2 id="upd-h">Project updates</h2>
        <p className="muted inv-small">{fresh > 0 ? `${fresh} new document${fresh === 1 ? "" : "s"} investors can read since your last update.` : "Add a document and have reviewers confirm its masking, and Elena can draft an update from it."}</p>
        <p className="elena-actions"><button type="button" onClick={draft} disabled={busy || fresh === 0 || drafts.length > 0}>{busy ? "Working…" : "Ask Elena to draft an update"}</button></p>
        {drafts.map(d => (
          <ul key={d.id} className="elena-list"><li>
            <span className="elena-tag draft">Draft, only you can see it</span>
            {edit?.id === d.id ? (
              <div className="elena-edit">
                <label htmlFor="ut">Title</label><input id="ut" value={edit.title} maxLength={120} onChange={e => setEdit({ ...edit, title: e.target.value })} />
                <label htmlFor="ub">Text investors will read</label><textarea id="ub" value={edit.body} maxLength={4000} onChange={e => setEdit({ ...edit, body: e.target.value })} />
                <div className="elena-actions"><button type="button" onClick={save} disabled={busy}>Save draft</button><button type="button" className="secondary" onClick={() => setEdit(null)}>Cancel</button></div>
              </div>
            ) : (
              <>
                <strong>{d.title}</strong><p className="elena-update-body">{d.body}</p>
                <p className="muted inv-small">{d.createdBy === "elena" ? "Written by Elena from your new documents. " : ""}Check every figure before you approve.</p>
                <div className="elena-actions"><button type="button" className="secondary" onClick={() => setEdit({ id: d.id, title: d.title, body: d.body })}>Edit</button><button type="button" onClick={() => publish(d.id)} disabled={busy}>Approve and publish</button></div>
              </>
            )}
          </li></ul>
        ))}
        <h3>Published</h3>
        {!updates ? <p className="muted" role="status">Loading…</p> : <UpdatesList updates={published} />}
      </section>

      <section className="panel elena-box" aria-labelledby="q-h">
        <h2 id="q-h">Investor questions{waiting.length + open.length > 0 ? ` (${waiting.length + open.length} waiting for you)` : ""}</h2>
        <fieldset className="elena-mode">
          <legend>How Elena answers investors</legend>
          <label><input type="radio" name="mode" checked={mode === "approve_first"} disabled={busy} onChange={() => changeMode("approve_first")} /> Draft first, I approve (recommended). Investors see an answer only after you approve it.</label>
          <label><input type="radio" name="mode" checked={mode === "instant"} disabled={busy} onChange={() => changeMode("instant")} /> Answer straight away by quoting my published documents.</label>
        </fieldset>
        {!questions ? <p className="muted" role="status">Loading…</p> : questions.length === 0 ? <p className="muted" role="status">No investor has asked Elena anything yet.</p> : (
          <ul className="elena-list">{questions.map(q => (
            <QuestionCard key={q.id} q={q}>
              {q.state === "pending_owner" && q.draft && (
                <div className="elena-edit">
                  <span className="elena-tag draft">Elena's draft, only you can see it</span>
                  <p className="elena-a">Elena would quote the published documents:</p>
                  <SourceList sources={q.draft.sources} />
                  {rev?.id === q.id ? (
                    <>
                      <label htmlFor={`e-${q.id}`}>Your answer (no contact details, street address or promised returns)</label>
                      <textarea id={`e-${q.id}`} value={rev.body} maxLength={2000} onChange={e => setRev({ id: q.id, body: e.target.value })} />
                      <div className="elena-actions"><button type="button" onClick={async () => { if (await decide(q.id, "edit", rev.body)) setRev(null); }} disabled={busy || rev.body.trim().length < 2}>Send my answer</button><button type="button" className="secondary" onClick={() => setRev(null)}>Cancel</button></div>
                    </>
                  ) : (
                    <div className="elena-actions">
                      <button type="button" onClick={() => decide(q.id, "approve")} disabled={busy}>Approve Elena's answer</button>
                      <button type="button" className="secondary" onClick={() => setRev({ id: q.id, body: "" })} disabled={busy}>Write my own</button>
                      <button type="button" className="secondary" onClick={() => decide(q.id, "discard")} disabled={busy}>Discard</button>
                    </div>
                  )}
                </div>
              )}
              {q.outcome === "escalated" && q.state === undefined && (reply?.id === q.id ? (
                <div className="elena-edit">
                  <label htmlFor={`r-${q.id}`}>Your reply (no contact details or street address)</label>
                  <textarea id={`r-${q.id}`} value={reply.body} maxLength={2000} onChange={e => setReply({ id: q.id, body: e.target.value })} />
                  <div className="elena-actions"><button type="button" onClick={sendReply} disabled={busy || reply.body.trim().length < 2}>Send reply</button><button type="button" className="secondary" onClick={() => setReply(null)}>Cancel</button></div>
                </div>
              ) : <div className="elena-actions"><button type="button" className="secondary" onClick={() => setReply({ id: q.id, body: "" })}>{q.replies.length ? "Reply again" : "Reply"}</button></div>)}
            </QuestionCard>
          ))}</ul>
        )}
        <p className="muted inv-small">You see each question and Elena's answer. You do not see who asked until they open a conversation with you.</p>
      </section>
    </main>
  );
}
