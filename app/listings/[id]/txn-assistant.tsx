"use client";
import { useCallback, useEffect, useState } from "react";
import { personaById, type PersonaId } from "../../../src/domain/assistant-persona";
import { JSON_HEADERS } from "../ui";
import "../../styles/transaction.css";

type Overview = {
  persona: { id: PersonaId; name: string }; stageLabel: string;
  insights: { completenessPct: number; requiredMissing: number; recommendedMissing: number; inspectionsOpen: number; awaitingMySignature: number; findings: { urgent: number; major: number; minor: number; info: number } };
};
type Answer = { desk: string; deskLabel: string; text: string; suggestions: string[] };
type Ai = { state: "ready"; text: string; note: string } | { state: "unavailable"; message: string } | null;
const FIRST = ["What documents are missing?", "What should I do next?", "Summarise the inspection findings", "What does 'subject to contract' mean?"];

/** The assistant for inspections, documents and signing. She explains and suggests; she never signs, sends or decides. */
export default function TxnAssistant({ listingId, refreshKey = 0 }: { listingId: string; refreshKey?: number }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [ai, setAi] = useState<Ai>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/listings/${listingId}/transaction-assistant`).then(async r => { if (r.ok) setOv(await r.json()); }).catch(() => undefined);
  }, [listingId, refreshKey]);

  const ask = useCallback(async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true); setError(""); setAi(null);
    const r = await fetch(`/api/listings/${listingId}/transaction-assistant`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ question }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { setAnswer(d.answer); setQ(""); } else setError(d.error ?? "Could not get an answer.");
  }, [listingId, busy]);

  const summarise = async () => {
    setBusy(true); setError("");
    const r = await fetch(`/api/listings/${listingId}/transaction-assistant`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ aiSummary: true }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) setAi(d.ai); else setError(d.error ?? "Could not get a summary.");
  };

  const p = personaById(ov?.persona.id);
  const name = ov?.persona.name ?? p.name;
  const i = ov?.insights;
  return (
    <section className="panel tx-elena" aria-labelledby="tx-elena-title">
      <div className="tx-elena-head">
        <img src={p.portrait} alt="" width={56} height={56} />
        <div><h2 id="tx-elena-title">Ask {name}</h2><p>{ov ? `${ov.stageLabel} · AI assistant` : "AI assistant"}</p></div>
      </div>
      {i && (
        <dl className="tx-stats" aria-label="Paperwork at a glance">
          <div><dt>Paperwork complete</dt><dd>{i.completenessPct}%</dd></div>
          <div><dt>Required missing</dt><dd>{i.requiredMissing}</dd></div>
          <div><dt>Open inspections</dt><dd>{i.inspectionsOpen}</dd></div>
          <div><dt>To sign</dt><dd>{i.awaitingMySignature}</dd></div>
        </dl>
      )}
      <div className="tx-chips">
        {(answer?.suggestions ?? FIRST).map(s => <button key={s} type="button" className="secondary" onClick={() => void ask(s)} disabled={busy}>{s}</button>)}
      </div>
      <form className="tx-ask" onSubmit={e => { e.preventDefault(); void ask(q); }}>
        <label className="sr-only" htmlFor="tx-q">Your question</label>
        <input id="tx-q" value={q} onChange={e => setQ(e.target.value)} maxLength={300} placeholder="Ask about documents, findings or terms" autoComplete="off" />
        <button type="submit" disabled={busy || !q.trim()}>Ask</button>
      </form>
      <div aria-live="polite">
        {busy && <p className="muted" role="status">{name} is working on it…</p>}
        {error && <p className="tx-err" role="alert">{error}</p>}
        {answer && <p className="tx-answer"><span className="tx-desk">{answer.deskLabel}</span>{answer.text}</p>}
        {ai?.state === "ready" && <p className="tx-answer"><span className="tx-desk">AI summary</span>{ai.text}<small className="muted"> {ai.note}</small></p>}
        {ai?.state === "unavailable" && <p className="muted">{ai.message}</p>}
      </div>
      <button type="button" className="secondary" onClick={() => void summarise()} disabled={busy}>AI summary of findings</button>
      <p className="muted"><small>{name} explains and suggests. She can&apos;t give legal, financial or valuation advice, and she never signs or sends anything for you.</small></p>
    </section>
  );
}
