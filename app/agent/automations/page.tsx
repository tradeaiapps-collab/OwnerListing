"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "../../styles/enquiries.css";
import "../../styles/agent-workspace.css";
import "../../styles/automations.css";

type Cond = { field: string; op: string; value: string | number };
type Group = { match: "all" | "any"; conditions: Cond[] };
type Step =
  | { id: string; kind: "send"; channel: "email" | "sms" | "in_app"; to: "contact" | "owner"; subject: string; body: string }
  | { id: string; kind: "wait"; minutes: number }
  | { id: string; kind: "branch"; when: Group; then: string; otherwise: string }
  | { id: string; kind: "stop" };
type Def = { trigger: string; when: Group; steps: Step[] };
type Trigger = { key: string; label: string; blurb: string; contact: boolean; fields: string[] };
type Field = { key: string; label: string; type: "text" | "number" };
type Workflow = { id: string; name: string; trigger: string; definition: Def; listingId: string | null; active: boolean; runs?: Record<string, number> };
type Catalogue = {
  workflows: Workflow[]; listings: { id: string; title: string }[]; triggers: Trigger[]; fields: Field[]; ops: Record<string, string>;
  templates: { key: string; name: string; blurb: string; definition: Def }[]; limits: { steps: number };
};
type LogLine = { id: string; at: string; kind: string; stepId: string | null; detail: string; outcome: string | null };
type Sim = { matched: boolean; steps: { stepId: string | null; text: string }[] };

const NUMERIC_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"], TEXT_OPS = ["eq", "neq", "contains", "not_contains"];
const UNITS = [{ k: "minutes", m: 1 }, { k: "hours", m: 60 }, { k: "days", m: 1440 }] as const;

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; message?: string } }> {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string; message?: string } };
}
const send = (method: string, data: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const emptyGroup = (): Group => ({ match: "all", conditions: [] });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** A branch may only jump forward. After any edit, point stale targets at "end". */
function tidy(steps: Step[]): Step[] {
  return steps.map((s, i) => {
    if (s.kind !== "branch") return s;
    const later = new Set(steps.slice(i + 1).map(x => x.id));
    return { ...s, then: s.then === "end" || later.has(s.then) ? s.then : "end", otherwise: s.otherwise === "end" || later.has(s.otherwise) ? s.otherwise : "end" };
  });
}

function ConditionEditor({ group, fields, allowed, ops, onChange, label }: { group: Group; fields: Field[]; allowed: string[]; ops: Record<string, string>; onChange: (g: Group) => void; label: string }) {
  const usable = fields.filter(f => allowed.includes(f.key));
  const set = (i: number, patch: Partial<Cond>) => onChange({ ...group, conditions: group.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <fieldset className="au-form">
      <legend>{label}</legend>
      {group.conditions.length > 1 && (
        <label>Match<select value={group.match} onChange={e => onChange({ ...group, match: e.target.value as "all" | "any" })}><option value="all">All of these</option><option value="any">Any of these</option></select></label>
      )}
      {group.conditions.length === 0 && <p className="au-empty">No conditions: it always applies.</p>}
      {group.conditions.map((c, i) => {
        const f = fields.find(x => x.key === c.field);
        const opList = f?.type === "number" ? NUMERIC_OPS : TEXT_OPS;
        return (
          <div className="au-cond" key={i}>
            <label>Field<select value={c.field} onChange={e => { const nf = fields.find(x => x.key === e.target.value); set(i, { field: e.target.value, op: "eq", value: nf?.type === "number" ? 0 : "" }); }}>
              {usable.map(u => <option key={u.key} value={u.key}>{u.label}</option>)}</select></label>
            <label>Is<select value={c.op} onChange={e => set(i, { op: e.target.value })}>{opList.map(o => <option key={o} value={o}>{ops[o]}</option>)}</select></label>
            <label>Value<input type={f?.type === "number" ? "number" : "text"} value={c.value} onChange={e => set(i, { value: f?.type === "number" ? Number(e.target.value) : e.target.value })} maxLength={120} /></label>
            <button type="button" className="secondary" aria-label={`Remove condition ${i + 1}`} onClick={() => onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        );
      })}
      {group.conditions.length < 10 && usable.length > 0 && (
        <div><button type="button" className="secondary" onClick={() => onChange({ ...group, conditions: [...group.conditions, { field: usable[0]!.key, op: "eq", value: usable[0]!.type === "number" ? 0 : "" }] })}>Add condition</button></div>
      )}
    </fieldset>
  );
}

/** Automations: a visual workflow builder (trigger, conditions, messages, delays, branches), starter campaigns, a dry-run test and an activity log. */
export default function Automations() {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [name, setName] = useState("");
  const [listingId, setListingId] = useState("");
  const [def, setDef] = useState<Def | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [sim, setSim] = useState<Sim | null>(null);

  const load = useCallback(async () => {
    const r = await call<Catalogue>("/api/agent/automations").catch(() => null);
    if (!r) return setError("Could not load your automations.");
    if (r.status === 401) return setError("Sign in to use automations.");
    if (!r.ok) return setError(r.body.error ?? r.body.message ?? "Could not load your automations.");
    setError(""); setCat(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const trig = useMemo(() => cat?.triggers.find(t => t.key === def?.trigger), [cat, def?.trigger]);
  const fieldsFor = trig?.fields ?? [];
  const mergeHelp = fieldsFor.map(f => `{{${f}}}`).join("  ");

  function open(w: Workflow | "new", d?: Def, n?: string) {
    setEditing(w); setSim(null); setNotice(""); setError(""); setLog([]);
    const base = w === "new" ? d ?? { trigger: "new_lead", when: emptyGroup(), steps: [] } : clone(w.definition);
    setDef(base); setName(w === "new" ? n ?? "" : w.name); setListingId(w === "new" ? "" : w.listingId ?? "");
    setFacts({});
    if (w !== "new") void call<{ log: LogLine[] }>(`/api/agent/automations/${w.id}`).then(r => r.ok && setLog(r.body.log));
  }
  const patch = (fn: (d: Def) => Def) => setDef(d => (d ? { ...fn(d), steps: tidy(fn(d).steps) } : d));
  const setStep = (i: number, s: Step) => patch(d => ({ ...d, steps: d.steps.map((x, j) => (j === i ? s : x)) }));
  const move = (i: number, by: -1 | 1) => patch(d => { const a = [...d.steps], j = i + by; if (j < 0 || j >= a.length) return d; [a[i], a[j]] = [a[j]!, a[i]!]; return { ...d, steps: a }; });
  const nextId = (d: Def) => { let n = d.steps.length + 1; while (d.steps.some(s => s.id === `s${n}`)) n++; return `s${n}`; };
  const add = (kind: Step["kind"]) => patch(d => {
    const id = nextId(d);
    const s: Step = kind === "send" ? { id, kind, channel: "email", to: trig?.contact ? "contact" : "owner", subject: "", body: "" }
      : kind === "wait" ? { id, kind, minutes: 1440 }
      : kind === "branch" ? { id, kind, when: { match: "all", conditions: [{ field: fieldsFor.find(f => cat?.fields.find(x => x.key === f)?.type === "number") ?? fieldsFor[0] ?? "listing_title", op: "gte", value: 1 }] }, then: "end", otherwise: "end" }
      : { id, kind: "stop" };
    return { ...d, steps: [...d.steps, s] };
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!def) return;
    setBusy(true); setError(""); setNotice("");
    const body = { name, definition: def, listingId: listingId || null };
    const r = editing === "new" ? await call<Workflow>("/api/agent/automations", send("POST", body)) : await call<Workflow>(`/api/agent/automations/${(editing as Workflow).id}`, send("PATCH", body));
    setBusy(false);
    if (!r.ok) return setError(r.body.error ?? r.body.message ?? "Could not save.");
    setEditing(r.body); setNotice(editing === "new" ? "Saved. It is switched off until you turn it on." : "Saved."); await load();
  }
  async function toggle(w: Workflow) {
    const r = await call<Workflow>(`/api/agent/automations/${w.id}`, send("PATCH", { active: !w.active }));
    if (!r.ok) return setError(r.body.error ?? r.body.message ?? "Could not change that.");
    setNotice(w.active ? "Paused. Runs in progress wait until you turn it back on." : "Turned on. It starts on the next matching event."); await load();
    if (typeof editing === "object" && editing?.id === w.id) setEditing(r.body);
  }
  async function archive(w: Workflow) {
    if (!window.confirm(`Archive "${w.name}"? Unfinished runs stop. Its history is kept.`)) return;
    const r = await call(`/api/agent/automations/${w.id}`, { method: "DELETE" });
    if (!r.ok) return setError(r.body.error ?? r.body.message ?? "Could not archive.");
    setEditing(null); setDef(null); setNotice("Archived."); await load();
  }
  async function test() {
    if (!def) return;
    setError(""); setSim(null);
    // Blank sample boxes get a stand-in value so merge fields show up in the preview.
    const filled: Record<string, string> = {};
    for (const f of fieldsFor) { const fd = cat?.fields.find(x => x.key === f); filled[f] = facts[f] || (fd?.type === "number" ? "1" : f === "contact_first_name" ? "Sam" : "Sample"); }
    const r = await call<Sim>("/api/agent/automations/draft/test", send("POST", { definition: def, facts: filled }));
    if (!r.ok) return setError(r.body.error ?? r.body.message ?? "The test could not run.");
    setSim(r.body);
  }

  const current = typeof editing === "object" && editing ? editing : null;
  return (
    <main className="aw">
      <h1>Automations</h1>
      <p><a href="/agent/workspace">Agent workspace</a> · When something happens on your listings, run steps for you: tell yourself, message the buyer, wait, or branch. Buyers only get what their notification settings allow, and marketing messages need their opt-in.</p>
      {error && <p role="alert" className="au-err">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!cat && !error && <p className="muted" role="status">Loading…</p>}
      {cat && (
        <div className="aw-main au-main">
          <div className="au-col">
            <section className="aw-card" aria-labelledby="au-list-h">
              <h2 id="au-list-h">Your workflows</h2>
              {cat.workflows.length === 0 && <p className="au-empty">None yet. Start from a campaign below.</p>}
              <ul className="au-list">
                {cat.workflows.map(w => (
                  <li key={w.id} className={current?.id === w.id ? "is-open" : undefined}>
                    <div className="au-row">
                      <button type="button" className="au-name" onClick={() => open(w)}>{w.name}</button>
                      <span className={`au-pill${w.active ? " on" : ""}`}>{w.active ? "On" : "Off"}</span>
                    </div>
                    <p className="aw-meta">{cat.triggers.find(t => t.key === w.trigger)?.label}{w.listingId ? " · one listing" : " · all listings"} · {Object.values(w.runs ?? {}).reduce((a, b) => a + b, 0)} runs{w.runs?.["waiting"] ? ` (${w.runs["waiting"]} waiting)` : ""}</p>
                    <div className="au-row">
                      <button type="button" className="secondary" onClick={() => void toggle(w)}>{w.active ? "Pause" : "Turn on"}</button>
                      <button type="button" className="secondary" onClick={() => void archive(w)}>Archive</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="aw-card" aria-labelledby="au-tpl-h">
              <h2 id="au-tpl-h">Start a campaign</h2>
              <ul className="au-tpls">
                {cat.templates.map(t => <li key={t.key}><button type="button" onClick={() => open("new", clone(t.definition), t.name)}><strong>{t.name}</strong><small>{t.blurb}</small></button></li>)}
                <li><button type="button" onClick={() => open("new")}><strong>Blank workflow</strong><small>Pick a trigger and build your own steps.</small></button></li>
              </ul>
            </section>
          </div>

          <div className="au-col">
            {!def && <section className="aw-card"><p className="au-empty">Choose a workflow or a campaign to open the builder.</p></section>}
            {def && (
              <form className="aw-card au-form" onSubmit={e => void save(e)} aria-labelledby="au-build-h">
                <h2 id="au-build-h">{editing === "new" ? "New workflow" : "Edit workflow"}</h2>
                <div className="au-fields">
                  <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required /></label>
                  <label>Applies to<select value={listingId} onChange={e => setListingId(e.target.value)}><option value="">All my listings</option>{cat.listings.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}</select></label>
                </div>

                <ol className="au-flow" aria-label="Workflow steps">
                  <li className="au-trigger">
                    <div className="au-kind"><strong>When</strong></div>
                    <label>Trigger<select value={def.trigger} onChange={e => patch(d => ({ trigger: e.target.value, when: emptyGroup(), steps: [] }))} disabled={def.steps.length > 0} title={def.steps.length > 0 ? "Remove the steps to change the trigger" : undefined}>
                      {cat.triggers.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
                    <p className="aw-meta">{trig?.blurb}{def.steps.length > 0 ? " Remove all steps to change the trigger." : ""}</p>
                    <ConditionEditor label="Only continue if" group={def.when} fields={cat.fields} allowed={fieldsFor} ops={cat.ops} onChange={g => patch(d => ({ ...d, when: g }))} />
                  </li>
                  {def.steps.map((s, i) => (
                    <li key={s.id}>
                      <div className="au-kind">
                        <strong>{i + 1}. {s.kind === "send" ? "Send a message" : s.kind === "wait" ? "Wait" : s.kind === "branch" ? "If / else" : "Stop"}</strong>
                        <span className="au-tools">
                          <button type="button" className="secondary" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                          <button type="button" className="secondary" aria-label={`Move step ${i + 1} down`} disabled={i === def.steps.length - 1} onClick={() => move(i, 1)}>↓</button>
                          <button type="button" className="secondary" aria-label={`Remove step ${i + 1}`} onClick={() => patch(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}>✕</button>
                        </span>
                      </div>
                      {s.kind === "send" && (
                        <>
                          <div className="au-fields">
                            <label>Channel<select value={s.channel} onChange={e => setStep(i, { ...s, channel: e.target.value as "email" | "sms" | "in_app" })}><option value="email">Email</option><option value="sms">SMS</option><option value="in_app">In-app</option></select></label>
                            <label>To<select value={s.to} onChange={e => setStep(i, { ...s, to: e.target.value as "contact" | "owner" })}>{trig?.contact && <option value="contact">The contact</option>}<option value="owner">Me</option></select></label>
                          </div>
                          <label>Subject<input value={s.subject} maxLength={120} onChange={e => setStep(i, { ...s, subject: e.target.value })} /></label>
                          <label>Message<textarea value={s.body} maxLength={1000} onChange={e => setStep(i, { ...s, body: e.target.value })} required /></label>
                          <p className="aw-meta">Merge fields: {mergeHelp}{s.to === "contact" ? ". Contacts only receive marketing messages if they opted in; SMS to contacts is not sent." : ""}</p>
                        </>
                      )}
                      {s.kind === "wait" && (() => {
                        const unit = [...UNITS].reverse().find(u => s.minutes % u.m === 0) ?? UNITS[0];
                        return (
                          <div className="au-fields">
                            <label>Wait for<input type="number" min={1} value={s.minutes / unit.m} onChange={e => setStep(i, { ...s, minutes: Math.max(1, Math.round(Number(e.target.value))) * unit.m })} /></label>
                            <label>Unit<select value={unit.k} onChange={e => { const u = UNITS.find(x => x.k === e.target.value)!; setStep(i, { ...s, minutes: (s.minutes / unit.m) * u.m }); }}>{UNITS.map(u => <option key={u.k} value={u.k}>{u.k}</option>)}</select></label>
                          </div>
                        );
                      })()}
                      {s.kind === "branch" && (
                        <>
                          <ConditionEditor label="If" group={s.when} fields={cat.fields} allowed={fieldsFor} ops={cat.ops} onChange={g => setStep(i, { ...s, when: g })} />
                          <div className="au-fields">
                            {(["then", "otherwise"] as const).map(k => (
                              <label key={k}>{k === "then" ? "If yes, go to" : "If no, go to"}
                                <select value={s[k]} onChange={e => setStep(i, { ...s, [k]: e.target.value })}>
                                  <option value="end">Finish</option>
                                  {def.steps.slice(i + 1).map((x, j) => <option key={x.id} value={x.id}>Step {i + j + 2}</option>)}
                                </select></label>
                            ))}
                          </div>
                        </>
                      )}
                      {s.kind === "stop" && <p className="aw-meta">The run ends here.</p>}
                    </li>
                  ))}
                </ol>
                {def.steps.length < cat.limits.steps && (
                  <div className="au-add" role="group" aria-label="Add a step">
                    <button type="button" className="secondary" onClick={() => add("send")}>+ Message</button>
                    <button type="button" className="secondary" onClick={() => add("wait")}>+ Wait</button>
                    <button type="button" className="secondary" onClick={() => add("branch")}>+ If / else</button>
                    <button type="button" className="secondary" onClick={() => add("stop")}>+ Stop</button>
                  </div>
                )}
                <div className="au-add">
                  <button type="submit" disabled={busy || !name.trim() || def.steps.length === 0}>{busy ? "Saving…" : "Save workflow"}</button>
                  {current && <button type="button" className="secondary" onClick={() => void toggle(current)}>{current.active ? "Pause" : "Turn on"}</button>}
                </div>

                <fieldset className="au-form">
                  <legend>Test with sample data (nothing is sent; blanks use a stand-in)</legend>
                  <div className="au-fields">
                    {fieldsFor.map(f => { const fd = cat.fields.find(x => x.key === f); return fd && (
                      <label key={f}>{fd.label}<input type={fd.type === "number" ? "number" : "text"} value={facts[f] ?? ""} onChange={e => setFacts({ ...facts, [f]: e.target.value })} maxLength={120} /></label>
                    ); })}
                  </div>
                  <div><button type="button" className="secondary" onClick={() => void test()} disabled={def.steps.length === 0}>Run test</button></div>
                  {sim && (
                    <ul className="au-sim" aria-live="polite">
                      {!sim.matched && <li>{sim.steps[0]?.text}</li>}
                      {sim.matched && sim.steps.length === 0 && <li>Nothing would happen.</li>}
                      {sim.steps.map((x, i) => <li key={i}>{x.text}</li>)}
                    </ul>
                  )}
                </fieldset>
              </form>
            )}

            {current && (
              <section className="aw-card" aria-labelledby="au-log-h">
                <h2 id="au-log-h">Activity</h2>
                {log.length === 0 ? <p className="au-empty">Nothing has run yet.</p> : (
                  <div className="au-scroll" role="region" aria-label="Activity log" tabIndex={0}>
                    <table>
                      <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Detail</th><th scope="col">Result</th></tr></thead>
                      <tbody>{log.map(l => <tr key={l.id}><td>{when(l.at)}</td><td>{l.kind.replace("_", " ")}</td><td>{l.detail}</td><td>{l.outcome ?? "–"}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
