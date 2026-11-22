"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AssistantPlan, AssistantQuestion, FeedbackEvent, RewriteMode, Rewrite } from "../../src/domain/listing-assistant";
import { priceInputToCents, formatAud } from "../../src/domain/listing-details";
import { useSearchPersona } from "./persona-context";
import { useElenaContext } from "../elena-context";
import { roomsFromText, sectionHint, sectionOfField } from "../../src/domain/elena-context";
import { JSON_HEADERS } from "./ui";

/** Small "?" button that opens one of Elena's tips under the field label. */
export function ElenaTip({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="ela-tip">
      <button type="button" className="ela-tip-btn secondary" aria-expanded={open} aria-controls={id} aria-label="Tip from Elena" onClick={() => setOpen(o => !o)}>?</button>
      {open && <span id={id} role="note" className="ela-tip-text">{text}</span>}
    </span>
  );
}

const ROOM_LABEL: Record<string, string> = { bedrooms: "Bedrooms", bathrooms: "Bathrooms", parking: "Parking spaces" };
const isEmpty = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? "").trim() === "";
interface Filled { field: string; label: string; value: string }

const dollars = (c: number, rent: boolean) => `${formatAud(c)}${rent ? " per week" : ""}`;
const words = (t: string) => (t.trim() === "" ? 0 : t.trim().split(/\s+/).length);

/** Reads what has been typed in the form so far. Returns null while there is nothing to ask about. */
function factsFrom(form: HTMLFormElement, photoCount: number | undefined) {
  const fd = new FormData(form), s = (k: string) => String(fd.get(k) ?? "").trim();
  const n = (k: string) => (/^\d+$/.test(s(k)) ? Number(s(k)) : undefined);
  const cents = s("price") === "" ? undefined : priceInputToCents(s("price"));
  const facts: Record<string, unknown> = {
    transactionType: s("transactionType") === "rent" ? "rent" : "sale", propertyType: s("propertyType") || "house",
    title: s("title"), description: s("description"), suburb: s("suburb"), postcode: /^\d{4}$/.test(s("postcode")) ? s("postcode") : "",
    amenities: fd.getAll("amenities").map(String)
  };
  for (const k of ["bedrooms", "bathrooms", "parking"]) { const v = n(k); if (v !== undefined && v <= 20) facts[k] = v; }
  if (cents !== undefined && cents > 0) facts["priceCents"] = cents;
  if (photoCount !== undefined) facts["photoCount"] = photoCount;
  return facts;
}

/** Sets a form control the way a person would, so the form and the other panels notice the change. */
export function setControl(form: HTMLFormElement, name: string, value: string) {
  // More than one control can share a name (quick setup and the full form sit in the same <form>), and namedItem then returns a list, so set every match.
  const els = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`input[name="${name}"], select[name="${name}"], textarea[name="${name}"]`));
  for (const el of els) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

type Answer = { kind: "text"; value: string } | { kind: "number"; value: number } | { kind: "yes" } | { kind: "no" } | { kind: "open" };

const FLAG: Record<string, string> = { furnished: "furnished", pets: "pet_friendly" };
const FIELD_LABEL: Record<string, string> = { suburb: "Suburb", bedrooms: "Bedrooms", bathrooms: "Bathrooms", parking: "Parking spaces", price: "Price" };
const SENTENCE_LEAD: Record<string, string> = { love: "", outdoor: "Outdoors: ", renovation: "Recent work: ", nearby: "Nearby: " };

/** Puts an answer into the form the way a person typing it would. Returns a one-line confirmation. */
function applyAnswer(form: HTMLFormElement, q: AssistantQuestion, a: Answer): string {
  if (a.kind === "number") { setControl(form, q.id, String(a.value)); return `${FIELD_LABEL[q.id]} set to ${a.value}. You can change it in the form.`; }
  if (a.kind === "text" && (q.id === "suburb" || q.id === "price")) { setControl(form, q.id, a.value.replace(/^\$/, "")); return `${FIELD_LABEL[q.id]} filled in.`; }
  if (a.kind === "text") {
    const now = String(new FormData(form).get("description") ?? "").trim();
    const sentence = `${SENTENCE_LEAD[q.id] ?? ""}${a.value.trim().replace(/^./, c => c.toUpperCase())}${/[.!?]$/.test(a.value.trim()) ? "" : "."}`;
    setControl(form, "description", now ? `${now}\n\n${sentence}` : sentence);
    return "Added to your description.";
  }
  if (a.kind === "yes" && FLAG[q.id]) {
    const box = form.querySelector<HTMLInputElement>(`input[name="amenities"][value="${FLAG[q.id]}"]`);
    if (box && !box.checked) box.click();
    return "Ticked in the features list.";
  }
  return "Noted.";
}

/** The answer control for one of Elena's questions, shown inside her card. Number chips, a text box, or yes/no. */
function ElenaAnswer({ q, rent, onAnswer, onSkip }: { q: AssistantQuestion; rent: boolean; onAnswer: (a: Answer) => void; onSkip: () => void }) {
  const [text, setText] = useState("");
  const id = useId();
  const skip = <button type="button" className="secondary" onClick={onSkip}>{q.essential ? "Skip for now" : "Not now"}</button>;
  if (q.id === "bedrooms" || q.id === "bathrooms" || q.id === "parking") {
    return (
      <div className="ela-actions" role="group" aria-label={q.question}>
        {[0, 1, 2, 3, 4, 5].map(n => <button key={n} type="button" className="ela-num" onClick={() => onAnswer({ kind: "number", value: n })}>{n === 5 ? "5+" : n}</button>)}
        {skip}
      </div>
    );
  }
  if (q.id === "furnished" || q.id === "pets") {
    return <div className="ela-actions"><button type="button" onClick={() => onAnswer({ kind: "yes" })}>Yes</button><button type="button" className="secondary" onClick={() => onAnswer({ kind: "no" })}>No</button>{skip}</div>;
  }
  if (q.id === "photos") {
    return <div className="ela-actions"><button type="button" onClick={() => onAnswer({ kind: "open" })}>Show me where</button>{skip}</div>;
  }
  const short = q.id === "suburb" || q.id === "price";
  const submit = () => { if (text.trim()) onAnswer({ kind: "text", value: text.trim() }); };
  return (
    <div className="ela-answer">
      <label htmlFor={id} className="sr-only">{q.question}</label>
      {short
        ? <input id={id} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            inputMode={q.id === "price" ? "decimal" : "text"} placeholder={q.id === "price" ? (rent ? "650" : "850000") : "e.g. Paddington"} autoComplete="off" />
        : <textarea id={id} rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Type it in your own words. Elena adds it to your description." maxLength={500} />}
      <div className="ela-actions"><button type="button" disabled={!text.trim()} onClick={submit}>Add answer</button>{skip}</div>
    </div>
  );
}

/**
 * Elena's guided listing creation: questions, tags, description rewriter, pricing, photo shots, marketing angles and where to
 * advertise, beside the form. She only suggests: every change needs a click, and nothing is saved until the author saves the form.
 */
export function ElenaListingAssistant({ photoCount }: { photoCount?: number }) {
  const persona = useSearchPersona();
  const anchor = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [plan, setPlan] = useState<AssistantPlan | null>(null);
  const [error, setError] = useState("");
  const [rw, setRw] = useState<Rewrite | null>(null);
  const [rwBusy, setRwBusy] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const applied = useRef<{ mode: RewriteMode; words: number } | null>(null);
  const [forgot, setForgot] = useState(false);
  // Open beside the form on wide screens; closed on phones so the form stays first.
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(window.matchMedia("(min-width: 720px)").matches); }, []);
  const here = useElenaContext();
  const [filled, setFilled] = useState<Filled[]>([]);
  const triedAuto = useRef<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteMsg, setNoteMsg] = useState("");
  const recommendedId = plan?.pricing.state === "ready" ? plan.pricing.recommended : undefined;
  const rent = plan?.pricing && formRef.current ? new FormData(formRef.current).get("transactionType") === "rent" : false;

  const send = useCallback((events: FeedbackEvent[]) => {
    void fetch("/api/listings/assistant/feedback", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ events }) }).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    const form = formRef.current;
    if (!form) return;
    try {
      const r = await fetch("/api/listings/assistant", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ facts: factsFrom(form, photoCount) }) });
      const d = await r.json();
      if (r.ok) { setPlan(d); setError(""); } else setError(r.status === 401 ? "Sign in to get Elena's help." : d.error ?? "Elena can't help right now.");
    } catch { setError("Elena can't help right now. You can keep filling in the form."); }
  }, [photoCount]);

  // Follow the form: ask again 800 ms after the author stops typing.
  useEffect(() => {
    const form = anchor.current?.closest("form") ?? null;
    formRef.current = form;
    if (!form) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    // Elena fills empty room counts from what the owner wrote in the description. Each field once: if they clear it, she leaves it.
    const autofill = () => {
      const found = roomsFromText(String(new FormData(form).get("description") ?? ""));
      const made: Filled[] = [];
      for (const [field, v] of Object.entries(found)) {
        if (triedAuto.current.has(field) || !isEmpty(form, field)) continue;
        triedAuto.current.add(field); setControl(form, field, String(v));
        made.push({ field, label: ROOM_LABEL[field]!, value: String(v) });
      }
      if (made.length) setFilled(f => [...f, ...made]);
    };
    const later = () => { clearTimeout(t); t = setTimeout(() => { autofill(); void refresh(); }, 800); };
    const blur = (e: FocusEvent) => {
      // After "Use this", record how far the author then edited Elena's text (length only, never the words).
      if ((e.target as HTMLElement | null)?.getAttribute?.("name") !== "description" || !applied.current) return;
      const now = words((e.target as HTMLTextAreaElement).value), was = applied.current.words;
      if (was > 0 && Math.abs(now - was) / was >= 0.1) send([{ kind: "rewrite", key: applied.current.mode, action: "edited", deltaPct: Math.round(((now - was) / was) * 100) }]);
      applied.current = null;
    };
    form.addEventListener("input", later); form.addEventListener("change", later); form.addEventListener("focusout", blur);
    void refresh();
    return () => { clearTimeout(t); form.removeEventListener("input", later); form.removeEventListener("change", later); form.removeEventListener("focusout", blur); };
  }, [refresh, send]);

  async function rewrite(mode: RewriteMode) {
    const form = formRef.current;
    if (!form) return;
    setRwBusy(true); setRw(null);
    try {
      const facts = factsFrom(form, photoCount);
      const r = await fetch("/api/listings/assistant/rewrite", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text: String(facts["description"] ?? ""), mode, facts }) });
      const d = await r.json();
      setRw(r.ok ? d : { state: "unavailable", message: d.error ?? "Elena can't help right now." });
    } catch { setRw({ state: "unavailable", message: "Elena can't help right now." }); } finally { setRwBusy(false); }
  }

  const form = () => formRef.current;
  const focus = (target: string) => {
    const f = form();
    const el = f?.elements.namedItem(target === "price" ? "price" : target);
    const node = el instanceof RadioNodeList ? el[0] : el;
    if (node instanceof HTMLElement) { node.scrollIntoView({ block: "center", behavior: "smooth" }); node.focus({ preventScroll: true }); }
    else if (target === "photos") document.querySelector(".gl-mgr")?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  /** Tell Elena in your own words: she reads the notes and fills only the fields that are still empty. */
  async function tell() {
    const f = form();
    if (!f || !notes.trim()) return;
    setNoteBusy(true); setNoteMsg("");
    try {
      const tx = new FormData(f).get("transactionType") === "rent" ? "rent" : "sale";
      const r = await fetch("/api/listings/assistant/quick-setup", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ notes: notes.trim(), transactionType: tx }) });
      const d = await r.json();
      if (!r.ok || d.state !== "ready") { setNoteMsg(d.error ?? d.message ?? "Elena could not read that. Try adding the suburb, rooms and price."); return; }
      const x = d.fields as Record<string, unknown>, made: Filled[] = [];
      const put = (field: string, label: string, v: unknown, shown?: string) => {
        if (v === undefined || v === "" || !isEmpty(f, field)) return;
        setControl(f, field, String(v)); triedAuto.current.add(field); made.push({ field, label, value: shown ?? String(v) });
      };
      put("suburb", "Suburb", x["suburb"]); put("postcode", "Postcode", x["postcode"]);
      put("bedrooms", "Bedrooms", x["bedrooms"]); put("bathrooms", "Bathrooms", x["bathrooms"]); put("parking", "Parking spaces", x["parking"]);
      if (typeof x["priceCents"] === "number") put("price", "Price", x["priceCents"] / 100, formatAud(x["priceCents"]));
      put("title", "Title", x["title"]); put("description", "Description", x["description"], "written from your notes");
      if (typeof x["jurisdiction"] === "string") setControl(f, "jurisdiction", x["jurisdiction"]);
      if (typeof x["propertyType"] === "string") setControl(f, "propertyType", x["propertyType"]);
      for (const a of Array.isArray(x["amenities"]) ? x["amenities"] : []) {
        const box = f.querySelector<HTMLInputElement>(`input[name="amenities"][value="${String(a)}"]`);
        if (box && !box.checked) { box.click(); made.push({ field: "amenities", label: "Feature", value: String(a).replace(/_/g, " ") }); }
      }
      setFilled(prev => [...prev, ...made]);
      setNoteMsg(made.length ? "Filled in below. Check each one and change anything that is wrong." : "Everything I found is already filled in.");
      if (made.length) setNotes("");
    } catch { setNoteMsg("Elena can't help right now. You can keep filling in the form."); } finally { setNoteBusy(false); }
  }
  const undo = (x: Filled) => {
    const f = form();
    if (f && x.field !== "amenities") setControl(f, x.field, "");
    setFilled(p => p.filter(y => y !== x));
  };
  /** Runs the action on the section hint. */
  function act(id: "pricing" | "rewrite" | "shots" | "tell") {
    const root = anchor.current;
    if (id === "rewrite") void rewrite("better");
    else if (id === "tell") root?.querySelector<HTMLElement>(".ela-tell textarea")?.focus();
    else if (id === "shots") { const d = root?.querySelector<HTMLDetailsElement>("details.ela-shots"); if (d) { d.open = true; d.scrollIntoView({ block: "center", behavior: "smooth" }); } }
    else root?.querySelector<HTMLElement>('section[aria-label="Pricing"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const hide = (key: string) => setGone(g => new Set(g).add(key));
  const [done, setDone] = useState("");
  /** Elena fills the form for the person: the answer goes straight into the field, nothing scrolls. */
  function answer(q: AssistantQuestion, a: Answer) {
    const f = form();
    if (!f) return;
    const msg = applyAnswer(f, q, a);
    send([{ kind: "question", key: q.id, action: "answered" }]);
    hide(`q-${q.id}`); setDone(msg);
    if (q.id === "photos") focus("photos");
  }
  function skip(q: AssistantQuestion) {
    if (!q.essential) send([{ kind: "question", key: q.id, action: "dismissed" }]);
    hide(`q-${q.id}`); setDone("");
  }
  async function forget() {
    await fetch("/api/listings/assistant/feedback", { method: "DELETE", headers: JSON_HEADERS }).catch(() => undefined);
    setForgot(true); void refresh();
  }

  return (
    <div ref={anchor} className="ela-assist" aria-label="Elena, listing assistant" role="region">
      <button type="button" className="ela-head secondary" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <img src={persona.icon} alt="" width={44} height={44} className="ela-avatar" />
        <span className="ela-head-text"><strong>{persona.name}</strong> <span className="badge">AI assistant</span>
          <span className="muted ela-sub">{open ? "Guidance as you fill in the form. You decide everything; nothing is saved until you save." : "Tap to open her questions, price guidance and photo tips."}</span></span>
        <span aria-hidden="true" className="ela-toggle">{open ? "−" : "+"}</span>
      </button>
      {open && error && <p role="status" className="muted">{error}</p>}
      {open && !plan && !error && <p role="status" className="muted">Elena is looking at your details…</p>}
      {open && plan && (
        <div className="ela-body">
          {here.section && (() => {
            const f = formRef.current;
            const h = sectionHint(here.section, { price: !f || isEmpty(f, "price"), description: !f || isEmpty(f, "description"), rooms: !f || isEmpty(f, "bedrooms") });
            return (
              <section aria-label="Where you are" className="ela-now" aria-live="polite">
                <p className="muted ela-fine">You are in: <strong>{here.sectionLabel}</strong></p>
                {h && <p>{h.text}</p>}
                {h?.action && <div className="ela-actions"><button type="button" className="secondary" onClick={() => act(h.action!.id)}>{h.action.label}</button></div>}
              </section>
            );
          })()}

          <section aria-label="Tell Elena" className="ela-tell">
            <h3>Tell Elena about the property</h3>
            <label htmlFor="ela-notes" className="sr-only">Describe the property in your own words</label>
            <textarea id="ela-notes" rows={2} value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} placeholder="e.g. 3 bed 2 bath house in Paddington QLD 4064, 2 car, pool, $850,000" />
            <div className="ela-actions"><button type="button" disabled={noteBusy || !notes.trim()} onClick={() => void tell()}>{noteBusy ? "Filling in…" : "Fill in the form"}</button></div>
            {noteMsg && <p role="status" className="muted">{noteMsg}</p>}
          </section>

          {filled.length > 0 && (
            <section aria-label="Filled in by Elena" aria-live="polite">
              <h3>Elena filled in</h3>
              <ul className="ela-chips">{filled.map(x => (
                <li key={x.field + x.value} className="ela-chip"><span>{x.label}: <strong>{x.value}</strong></span>
                  {x.field !== "amenities" && <button type="button" className="secondary" onClick={() => undo(x)} aria-label={`Undo ${x.label}`}>Undo</button>}</li>
              ))}</ul>
            </section>
          )}

          {(() => {
            // The question about the section the person is in comes first.
            const qs = plan.questions.filter(q => !gone.has(`q-${q.id}`)).sort((a, b) => Number(sectionOfField(b.target) === here.section) - Number(sectionOfField(a.target) === here.section));
            const q = qs[0];
            return (
              <section aria-label="Questions from Elena" aria-live="polite">
                {done && <p role="status" className="ela-done">{done}</p>}
                {q && (
                  <>
                    <h3>Elena asks <span className="muted ela-count">{qs.length === 1 ? "last question" : `${qs.length} questions left`}</span></h3>
                    <p><strong>{q.question}</strong><br /><span className="muted">{q.why}</span></p>
                    <ElenaAnswer key={q.id} q={q} rent={rent} onAnswer={a => answer(q, a)} onSkip={() => skip(q)} />
                  </>
                )}
              </section>
            );
          })()}

          <section aria-label="Description">
            <h3>Description</h3>
            <div className="ela-actions">
              <button type="button" className="secondary" disabled={rwBusy} onClick={() => void rewrite("better")}>Make it better</button>
              <button type="button" className="secondary" disabled={rwBusy} onClick={() => void rewrite("shorter")}>Make it shorter</button>
            </div>
            {rwBusy && <p role="status" className="muted">Working…</p>}
            {rw && rw.state !== "ready" && <p role="status" className="muted">{rw.message}</p>}
            {rw?.state === "ready" && (
              <div className="ela-result" role="status">
                <p className="muted">{rw.label}. {rw.beforeWords} words to {rw.afterWords}.</p>
                <p className="ela-preview">{rw.text}</p>
                <ul className="plain-list">{rw.changes.map(c => <li key={c}>{c}</li>)}</ul>
                <div className="ela-actions">
                  <button type="button" onClick={() => {
                    const f = form(); if (!f) return;
                    setControl(f, "description", rw.text);
                    applied.current = { mode: rw.mode, words: rw.afterWords };
                    send([{ kind: "rewrite", key: rw.mode, action: "accepted" }]); setRw(null);
                  }}>Use this</button>
                  <button type="button" className="secondary" onClick={() => { send([{ kind: "rewrite", key: rw.mode, action: "dismissed" }]); setRw(null); }}>Keep mine</button>
                </div>
              </div>
            )}
          </section>

          {plan.tags.filter(t => !gone.has(`t-${t.id}`) && !t.alreadySet).length > 0 && (
            <section aria-label="Suggested tags">
              <h3>Features Elena found</h3>
              <ul className="ela-chips">
                {plan.tags.filter(t => !gone.has(`t-${t.id}`) && !t.alreadySet).map(t => (
                  <li key={t.id} className="ela-chip">
                    <span>{t.label} <span className="muted">from “{t.evidence}”</span></span>
                    {t.kind === "amenity" && <button type="button" onClick={() => {
                      const box = form()?.querySelector<HTMLInputElement>(`input[name="amenities"][value="${t.id}"]`);
                      if (box && !box.checked) box.click();
                      send([{ kind: "tag", key: t.id, action: "accepted" }]); hide(`t-${t.id}`);
                    }}>Tick</button>}
                    <button type="button" className="secondary" aria-label={`Skip ${t.label}`} onClick={() => { send([{ kind: "tag", key: t.id, action: "dismissed" }]); hide(`t-${t.id}`); }}>Skip</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label="Pricing">
            <h3>Pricing</h3>
            {plan.pricing.state === "unavailable" ? (
              <p className="muted">{plan.pricing.message} {plan.pricing.positionNote}</p>
            ) : (
              <>
                <p><strong>{dollars(plan.pricing.lowCents, rent)} to {dollars(plan.pricing.highCents, rent)}</strong> <span className="muted">(middle {dollars(plan.pricing.midCents, rent)}, confidence {Math.round(plan.pricing.confidence * 100)}%)</span></p>
                <p>{plan.pricing.positionNote}</p>
                <ul className="ela-list">
                  {plan.pricing.options.map(o => (
                    <li key={o.id}>
                      <p><strong>{o.label}: {dollars(o.priceCents, rent)}</strong>{o.id === recommendedId && <> <span className="badge badge-accepted">Elena suggests</span></>}<br /><span className="muted">{o.tradeoff}</span></p>
                      <button type="button" className="secondary" onClick={() => {
                        const f = form(); if (!f) return;
                        setControl(f, "price", String(o.priceCents / 100)); send([{ kind: "pricing", key: o.id, action: "chosen" }]);
                      }}>Use this price</button>
                    </li>
                  ))}
                </ul>
                <p className="muted">{plan.pricing.recommendedBecause}{plan.pricing.typicalDaysOnMarket !== undefined ? ` Similar properties took about ${plan.pricing.typicalDaysOnMarket} days to ${rent ? "lease" : "sell"}.` : ""}</p>
              </>
            )}
            <p className="muted ela-fine">{plan.pricing.note}</p>
          </section>

          <details className="ela-shots">
            <summary>Photo shot list ({plan.photos.have !== undefined ? `${plan.photos.have} of about ${plan.photos.target}` : `about ${plan.photos.target} photos`})</summary>
            <p>{plan.photos.message}</p>
            <ol className="plain-list">{plan.photos.shots.map(s => <li key={s.id}><strong>{s.title}</strong>{s.essential ? "" : " (optional)"}. <span className="muted">{s.tip}</span></li>)}</ol>
          </details>

          {plan.angles.length > 0 && (
            <details>
              <summary>Marketing angle</summary>
              <ul className="ela-list">{plan.angles.map(a => <li key={a.id}><p><strong>{a.title}</strong><br />Headline idea: “{a.headline}”<br /><span className="muted">{a.why}</span></p>
                <button type="button" className="secondary" onClick={() => { const f = form(); if (f) setControl(f, "title", a.headline.slice(0, 200)); }}>Use as title</button></li>)}</ul>
            </details>
          )}

          <details>
            <summary>Where to advertise</summary>
            <ul className="ela-list">{plan.channels.map(c => <li key={c.id}><p><strong>{c.label}</strong> <span className="badge">{c.status === "ready" ? "Included" : c.status === "optional" ? "Optional" : "Needs an agent"}</span><br /><span className="muted">{c.why}</span></p></li>)}</ul>
          </details>

          <details>
            <summary>What Elena has learned from you</summary>
            {plan.learned.length === 0 || forgot ? <p className="muted">Nothing yet. Elena learns from which suggestions you keep, skip or edit. It stays with your account and is never published.</p>
              : <ul className="plain-list">{plan.learned.map(l => <li key={l}>{l}</li>)}</ul>}
            <button type="button" className="secondary" onClick={() => void forget()}>Forget what Elena learned</button>
          </details>
        </div>
      )}
    </div>
  );
}
