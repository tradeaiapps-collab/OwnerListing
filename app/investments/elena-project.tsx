"use client";
import { useCallback, useEffect, useState } from "react";
import { NOT_ADVICE } from "../../src/domain/elena-projects";
import type { Outcome, Source } from "../../src/domain/elena-projects";
import type { QuestionState } from "../../src/domain/elena-projects-service";
import { send } from "./ui";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
export const OUTCOME_LABEL: Record<Outcome, string> = { answered: "Answered from documents", escalated: "Sent to the owner", declined: "Elena can't help with this" };

export interface QView { state?: QuestionState; draft?: { text: string; sources: Source[] }; id: string; question: string; answer: string; outcome: Outcome; sources: Source[]; createdAt: string; replies: { id: string; body: string; createdAt: string }[] }
export interface UView { id: string; title: string; body: string; status: "draft" | "published"; createdBy: "elena" | "owner"; createdAt: string; approvedAt?: string }

export function SourceList({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return <>{sources.map((s, i) => <blockquote key={i} className="elena-src">“{s.quote}”<cite>{s.title}{s.page ? `, page ${s.page}` : ""}</cite></blockquote>)}</>;
}

export const STATE_LABEL: Record<QuestionState, string> = {
  pending_owner: "Owner is checking", owner_approved: "Approved by the owner", owner_edited: "Answered by the owner", owner_discarded: "The owner will reply"
};

export function QuestionCard({ q, children }: { q: QView; children?: React.ReactNode }) {
  const released = !q.state || q.state === "owner_approved";
  return (
    <li>
      <p className="elena-q">{q.question}</p>
      <span className={`elena-tag ${q.state === "pending_owner" ? "draft" : q.outcome}`}>{q.state ? STATE_LABEL[q.state] : OUTCOME_LABEL[q.outcome]}</span>
      <p className="elena-a">{q.outcome === "answered" && released ? "Elena quoted the published documents:" : q.answer}</p>
      {released && <SourceList sources={q.sources} />}
      {q.replies.map(r => <p key={r.id} className="elena-reply"><strong>Project owner, {when(r.createdAt)}:</strong> {r.body}</p>)}
      <span className="muted inv-small">{when(q.createdAt)}</span>
      {children}
    </li>
  );
}

/** Published updates, as the investor sees them. */
export function UpdatesList({ updates }: { updates: UView[] }) {
  if (updates.length === 0) return <p className="muted" role="status">No updates yet.</p>;
  return (
    <ul className="elena-list">
      {updates.map(u => <li key={u.id}><strong>{u.title}</strong><span className="muted inv-small">Approved by the project owner · {when(u.approvedAt ?? u.createdAt)}</span><p className="elena-update-body">{u.body}</p></li>)}
    </ul>
  );
}

/** Investor side of the project page: updates and follow, then ask Elena. */
export function InvestorElena({ projectId }: { projectId: string }) {
  const [questions, setQuestions] = useState<QView[] | null>(null);
  const [updates, setUpdates] = useState<UView[] | null>(null);
  const [following, setFollowing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const base = `/api/investments/projects/${projectId}`;

  const load = useCallback(async () => {
    const [q, u] = await Promise.all([fetch(`${base}/elena/questions`), fetch(`${base}/updates`)]).catch(() => [null, null] as const);
    if (!q || !u || !q.ok || !u.ok) { setLoadError("Elena's notes could not be loaded."); setQuestions([]); setUpdates([]); return; }
    setLoadError("");
    setQuestions(((await q.json()) as { questions: QView[] }).questions);
    const ud = (await u.json()) as { updates: UView[]; following: boolean };
    setUpdates(ud.updates); setFollowing(ud.following);
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    const r = await send(`${base}/elena/ask`, "POST", { question: text });
    setBusy(false);
    if (r.ok) { setText(""); await load(); } else setError(String(r.data["error"] ?? "Elena could not answer right now."));
  }
  async function follow() {
    setError("");
    const r = await send(`${base}/follow`, following ? "DELETE" : "PUT", {});
    if (r.ok) setFollowing(!following); else setError(String(r.data["error"] ?? "Could not change that."));
  }
  const latest = questions?.[0];

  return (
    <>
      <section className="panel" id="updates" aria-labelledby="upd-h">
        <h2 id="upd-h">Project updates</h2>
        <p className="muted inv-small">Written or approved by the project owner. Follow the project to get a notice when a new update is published.</p>
        <p className="elena-actions"><button type="button" className="secondary" onClick={follow} aria-pressed={following}>{following ? "Following (tap to stop)" : "Follow this project"}</button></p>
        {!updates ? <p className="muted" role="status">Loading…</p> : <UpdatesList updates={updates} />}
      </section>
      <section className="panel elena-box" id="ask-elena" aria-labelledby="ask-h">
        <h2 id="ask-h">Ask Elena about this project</h2>
        <p className="muted inv-small">Elena answers only from the documents and details the owner has published, and quotes them. The project owner may check her answer before you see it. If she can't find an answer, your question goes to the owner. She never shows the project's exact address.</p>
        <form className="elena-form" onSubmit={ask}>
          <label htmlFor="elena-q">Your question</label>
          <textarea id="elena-q" value={text} onChange={e => setText(e.target.value)} maxLength={500} required minLength={5} placeholder="For example: when is council approval expected?" />
          <div className="elena-row"><span className="elena-count" aria-live="polite">{text.length}/500</span><button type="submit" disabled={busy || text.trim().length < 5}>{busy ? "Elena is reading…" : "Ask Elena"}</button></div>
        </form>
        {error && <p role="alert" className="inv-error">{error}</p>}
        {loadError && <p role="alert">{loadError}</p>}
        {latest && <ul className="elena-list" aria-live="polite"><QuestionCard q={latest} /></ul>}
        {questions && questions.length > 1 && (
          <details><summary>Your earlier questions ({questions.length - 1})</summary><ul className="elena-list">{questions.slice(1).map(q => <QuestionCard key={q.id} q={q} />)}</ul></details>
        )}
        {questions && questions.length === 0 && !loadError && <p className="muted" role="status">You haven't asked anything yet.</p>}
        <p className="elena-notice" role="note">{NOT_ADVICE}</p>
      </section>
    </>
  );
}
