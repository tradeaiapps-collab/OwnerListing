"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../../inspections/ui";

const KINDS = [
  { key: "booking_confirmation", label: "Booking confirmation", help: "Offered as soon as you accept a booking." },
  { key: "reminder_24h", label: "24-hour reminder", help: "Offered 24 hours before the inspection." }
] as const;
const VOICES = ["friendly", "professional", "casual", "formal"] as const;
const VARIABLES = ["buyer_name", "agent_name", "property_address", "appointment_time", "listing_title", "buyer_notes"];
type Kind = (typeof KINDS)[number]["key"];
type Voice = (typeof VOICES)[number];
type Stored = { kind: Kind; voice: Voice; body: string };
type Loaded = { mine: Stored[]; fallback: Stored[]; builtIn: Record<Kind, Record<Voice, string>> };

/**
 * Edits Elena's wording for scheduling messages. `endpoint` is the agent's own templates (/api/inspector/message-templates) or the
 * platform-wide ones (/api/staff/scheduling-templates); `scope` only changes the words on screen.
 */
export default function TemplateEditor({ endpoint, scope }: { endpoint: string; scope: "agent" | "platform" }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Record<string, { voice: Voice; body: string }>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(endpoint).catch(() => null);
    if (!r || !r.ok) { setError(r?.status === 401 ? "Sign in to edit templates." : "Could not load templates."); return; }
    const d = await r.json();
    const mine: Stored[] = scope === "agent" ? d.own : d.templates;
    const fallback: Stored[] = scope === "agent" ? d.platform : [];
    setData({ mine, fallback, builtIn: d.builtIn });
    const next: Record<string, { voice: Voice; body: string }> = {};
    for (const k of KINDS) {
      const cur = mine.find(t => t.kind === k.key) ?? fallback.find(t => t.kind === k.key);
      next[k.key] = cur ? { voice: cur.voice, body: cur.body } : { voice: "friendly", body: d.builtIn[k.key].friendly };
    }
    setDraft(next);
  }, [endpoint, scope]);
  useEffect(() => { void load(); }, [load]);

  async function save(kind: Kind) {
    setBusy(kind); setError(""); setNote("");
    const r = await fetch(endpoint, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ kind, ...draft[kind] }) }).catch(() => null);
    setBusy("");
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(r ? d.error ?? "Could not save." : "Network error."); return; }
    setNote("Saved. New drafts use this wording."); await load();
  }
  async function reset(kind: Kind) {
    setBusy(kind); setError(""); setNote("");
    const r = await fetch(`${endpoint}?kind=${kind}`, { method: "DELETE", headers: JSON_HEADERS }).catch(() => null);
    setBusy("");
    if (!r?.ok) { setError("Could not reset."); return; }
    setNote(scope === "agent" ? "Reset to the platform wording." : "Reset to Elena's built-in wording."); await load();
  }

  if (!data) return <p className="muted" role="status">{error || "Loading…"}</p>;
  return (
    <div className="elena-templates">
      <div aria-live="polite">{error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}</div>
      <p className="muted">
        Use {VARIABLES.map(v => <code key={v}>[{v}]</code>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " ", x] : [x]), [])}. A line that holds only
        <code>[buyer_notes]</code> is left out when the buyer wrote no note.
        {scope === "agent" ? " Your wording replaces the platform wording for your own drafts." : " Agents can still replace this with their own wording."}
      </p>
      {KINDS.map(k => {
        const d = draft[k.key]!;
        const custom = data.mine.some(t => t.kind === k.key);
        return (
          <section key={k.key} className="insp-panel insp-form">
            <h2>{k.label} {custom && <span className="badge">Customised</span>}</h2>
            <p className="muted">{k.help}</p>
            <label>Voice
              <select value={d.voice} onChange={e => { const voice = e.target.value as Voice; setDraft({ ...draft, [k.key]: { voice, body: data.builtIn[k.key][voice] } }); }}>
                {VOICES.map(v => <option key={v} value={v}>{v[0]!.toUpperCase() + v.slice(1)}</option>)}
              </select>
              <span className="muted">Choosing a voice fills in Elena&apos;s built-in text for it. Edit it however you like.</span>
            </label>
            <label>Message
              <textarea rows={9} maxLength={1500} value={d.body} onChange={e => setDraft({ ...draft, [k.key]: { ...d, body: e.target.value } })} />
            </label>
            <div className="actions">
              <button type="button" disabled={busy === k.key || d.body.trim().length < 20} onClick={() => save(k.key)}>{busy === k.key ? "Saving…" : "Save"}</button>
              {custom && <button type="button" className="secondary" disabled={busy === k.key} onClick={() => reset(k.key)}>Reset</button>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
