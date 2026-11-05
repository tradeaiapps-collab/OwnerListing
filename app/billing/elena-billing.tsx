"use client";
import { useRef, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

interface Answer { topic: string; text: string; links: { label: string; href: string }[]; suggestions: string[]; disclaimer: string }
interface Turn { from: "me" | "elena"; text: string; answer?: Answer }

const START = ["How do I pay an invoice?", "What is GST on my invoice?", "My payment failed", "How does my subscription renew?"];

/** Elena's billing help. Answers come from the person's own invoices and plan (see src/domain/billing-assistant.ts). */
export default function ElenaBilling({ onChanged }: { onChanged?: () => void }) {
  const [log, setLog] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<string[]>(START);
  const end = useRef<HTMLDivElement>(null);

  async function ask(q: string) {
    const t = q.trim();
    if (!t || busy) return;
    setBusy(true); setText("");
    setLog(l => [...l, { from: "me", text: t }]);
    try {
      const r = await fetch("/api/billing/assistant", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text: t }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setLog(l => [...l, { from: "elena", text: d.text, answer: d }]); setChips(d.suggestions?.length ? d.suggestions : START); onChanged?.(); }
      else setLog(l => [...l, { from: "elena", text: r.status === 401 ? "Sign in to ask about your billing." : d.error ?? "Sorry, I can't answer right now." }]);
    } catch {
      setLog(l => [...l, { from: "elena", text: "Sorry, I can't answer right now." }]);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ block: "nearest" }), 0);
    }
  }

  return (
    <section className="panel elena-bill" aria-labelledby="elena-bill-h">
      <div className="elena-bill-head">
        <img src="/assistant/elena-icon.png" alt="" width={48} height={48} />
        <div><h2 id="elena-bill-h" style={{ margin: 0 }}>Ask Elena about billing</h2><p className="muted">Set answers about your own invoices. Not a person.</p></div>
      </div>
      <div className="elena-log" role="log" aria-live="polite" aria-label="Conversation with Elena">
        {log.length === 0 && <p className="muted">Pick a question or type your own.</p>}
        {log.map((t, i) => (
          <div key={i} className={`elena-msg ${t.from}`}>
            <p>{t.text}</p>
            {t.answer && t.answer.links.length > 0 && <p style={{ marginTop: "var(--space-2)" }}>{t.answer.links.map(l => <a key={l.href + l.label} href={l.href} style={{ marginRight: "var(--space-3)" }}>{l.label}</a>)}</p>}
            {t.answer && <small>{t.answer.disclaimer}</small>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="elena-chips">{chips.map(c => <button key={c} type="button" disabled={busy} onClick={() => void ask(c)}>{c}</button>)}</div>
      <form className="elena-form" onSubmit={e => { e.preventDefault(); void ask(text); }}>
        <label className="sr-only" htmlFor="elena-bill-q">Your question</label>
        <input id="elena-bill-q" value={text} maxLength={300} onChange={e => setText(e.target.value)} placeholder="Ask about an invoice, GST or your plan" autoComplete="off" />
        <button type="submit" disabled={busy || !text.trim()}>{busy ? "..." : "Ask"}</button>
      </form>
    </section>
  );
}
