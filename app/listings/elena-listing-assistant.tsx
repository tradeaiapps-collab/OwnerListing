"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AssistantPlan, FeedbackEvent, RewriteMode, Rewrite } from "../../src/domain/listing-assistant";
import { dollarsToCents, formatAud } from "../../src/domain/listing-details";
import { useSearchPersona } from "./persona-context";
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

const dollars = (c: number, rent: boolean) => `${formatAud(c)}${rent ? " per week" : ""}`;
const words = (t: string) => (t.trim() === "" ? 0 : t.trim().split(/\s+/).length);

/** Reads what has been typed in the form so far. Returns null while there is nothing to ask about. */
function factsFrom(form: HTMLFormElement, photoCount: number | undefined) {
  const fd = new FormData(form), s = (k: string) => String(fd.get(k) ?? "").trim();
  const n = (k: string) => (/^\d+$/.test(s(k)) ? Number(s(k)) : undefined);
  const cents = s("price") === "" ? undefined : dollarsToCents(s("price"));
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
function setControl(form: HTMLFormElement, name: string, value: string) {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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
    const later = () => { clearTimeout(t); t = setTimeout(() => void refresh(), 800); };
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
  const hide = (key: string) => setGone(g => new Set(g).add(key));
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
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && error && <p role="status" className="muted">{error}</p>}
      {open && !plan && !error && <p role="status" className="muted">Elena is looking at your details…</p>}
      {open && plan && (
        <div className="ela-body">
          {plan.questions.filter(q => !gone.has(`q-${q.id}`)).length > 0 && (
            <section aria-label="Questions from Elena">
              <h3>Elena asks</h3>
              <ul className="ela-list">
                {plan.questions.filter(q => !gone.has(`q-${q.id}`)).map(q => (
                  <li key={q.id}>
                    <p><strong>{q.question}</strong><br /><span className="muted">{q.why}</span></p>
                    <div className="ela-actions">
                      <button type="button" onClick={() => { send([{ kind: "question", key: q.id, action: "answered" }]); focus(q.target); }}>Answer</button>
                      {!q.essential && <button type="button" className="secondary" onClick={() => { send([{ kind: "question", key: q.id, action: "dismissed" }]); hide(`q-${q.id}`); }}>Not now</button>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

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

          <details>
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
