"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MaskBox } from "../../../../../src/domain/doc-masking";
import { loadError, postStaff } from "../../../staff-api";

interface State {
  document: { id: string; projectId: string; title: string; kind: string; contentType: string };
  pageCount: number; textFound: boolean; revision: number; confirmed: boolean; boxes: MaskBox[]; terms: string[];
}
type Note = { kind: "ok" | "error"; text: string };
const API = "/api/staff/investments/documents";

/**
 * Staff screen for one document: Elena's auto-mask, boxes drawn or removed by hand, then confirm. The page images here are the ORIGINAL
 * pages (staff only, watermarked); "Investor view" shows the masked result exactly as an investor gets it.
 */
export default function MaskDocument() {
  const { id } = useParams<{ id: string }>();
  const [st, setSt] = useState<State | null>(null);
  const [boxes, setBoxes] = useState<MaskBox[]>([]);
  const [terms, setTerms] = useState("");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<number | null>(null);
  const [view, setView] = useState<"edit" | "investor">("edit");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState("");
  const [allow, setAllow] = useState(false);
  const [imgKey, setImgKey] = useState(0);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<MaskBox | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const booted = useRef(false);

  const apply = (s: State) => { setSt(s); setBoxes(s.boxes); setTerms(s.terms.join("\n")); setDirty(false); setSel(null); setImgKey(k => k + 1); };
  const load = useCallback(async () => {
    const r = await fetch(`${API}/${id}/mask`).catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) { setError(r.status === 404 ? "Document not found." : r.status === 400 ? "Only documents shared with investors need masking." : loadError(r.status)); return; }
    const s: State = await r.json();
    if (s.pageCount === 0) {
      // First visit: run the auto-mask so there is a proposal to review.
      const a = await postStaff(`${API}/${id}/mask`, { action: "auto", expectedRevision: 0 });
      if (a.ok) { apply(a.data as unknown as State); setNote({ kind: "ok", text: "Elena's auto-mask has proposed boxes. Check every page, then confirm." }); }
      else setError(String(a.data["error"] ?? "Could not read this file."));
      return;
    }
    apply(s);
  }, [id]);
  // Once per visit (React runs effects twice in development, and a second first-time auto-mask would collide with the first).
  useEffect(() => { if (booted.current) return; booted.current = true; void load(); }, [load]);

  const termList = () => terms.split("\n").map(t => t.trim()).filter(Boolean);
  async function run(body: Record<string, unknown>, done: string) {
    if (!st) return;
    setBusy(true); setNote(null);
    const r = await postStaff(`${API}/${id}/mask`, { expectedRevision: st.revision, terms: termList(), ...body });
    setBusy(false);
    if (r.ok) { apply(r.data as unknown as State); setNote({ kind: "ok", text: done }); setAllow(false); }
    else setNote({ kind: "error", text: String(r.data["error"] ?? "That did not work.") });
  }
  const save = (confirm: boolean) => run({ action: "save", boxes, confirm, allowUncovered: allow }, confirm ? "Masking confirmed. Investors can read this document once the project is approved." : "Saved. Not confirmed yet, so investors cannot see it.");

  const pt = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: React.PointerEvent) => {
    if (view !== "edit" || e.target !== e.currentTarget) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = pt(e); setSel(null);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = pt(e), s = drag.current;
    setDraft({ page, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y), source: "manual" });
  };
  const up = () => {
    if (draft && draft.w > 0.005 && draft.h > 0.004) { setBoxes(b => [...b, draft]); setDirty(true); setSel(boxes.length); }
    drag.current = null; setDraft(null);
  };
  const remove = (i: number) => { setBoxes(b => b.filter((_, k) => k !== i)); setSel(null); setDirty(true); };

  if (error) return <main className="sr-page"><p role="alert" className="sr-banner is-error">{error}</p><p><a href="/staff/investments#masking">Back to documents to mask</a></p></main>;
  if (!st) return <main className="sr-page"><p className="muted" role="status">Loading…</p></main>;
  const here = boxes.map((b, i) => ({ b, i })).filter(x => x.b.page === page);
  const q = view === "investor" ? "?view=investor" : "";
  return (
    <main className="sr-page mask-page">
      <p className="inv-back"><a href="/staff/investments#masking">Back to documents to mask</a></p>
      <header className="inv-page-head">
        <div>
          <h1>Mask addresses: {st.document.title}</h1>
          <p className="muted">Original pages are visible to staff only. Investors get flat page images with these boxes burned in. {st.confirmed ? "Status: confirmed." : "Status: not confirmed, investors cannot see it."}</p>
        </div>
      </header>
      <div aria-live="polite">{note && <p className={`sr-banner is-${note.kind}`} role={note.kind === "error" ? "alert" : "status"}>{note.text}</p>}</div>
      {!st.textFound && <p className="staff-notice">This file has no readable text (a scan or an image), so auto-mask cannot find addresses. Look at every page and draw boxes over any address before confirming.</p>}

      <div className="mask-layout">
        <section className="mask-main" aria-label="Page">
          <div className="mask-toolbar">
            <div className="mask-pager" role="group" aria-label="Page">
              <button type="button" className="secondary" disabled={page <= 1} onClick={() => { setPage(page - 1); setSel(null); }}>Previous</button>
              <span aria-live="polite">Page {page} of {st.pageCount}</span>
              <button type="button" className="secondary" disabled={page >= st.pageCount} onClick={() => { setPage(page + 1); setSel(null); }}>Next</button>
            </div>
            <div className="mask-view" role="group" aria-label="View">
              <button type="button" className={view === "edit" ? "" : "secondary"} aria-pressed={view === "edit"} onClick={() => setView("edit")}>Edit boxes</button>
              <button type="button" className={view === "investor" ? "" : "secondary"} aria-pressed={view === "investor"} disabled={!st.confirmed || dirty} title={st.confirmed && !dirty ? "" : "Confirm and save first"} onClick={() => setView("investor")}>Investor view</button>
            </div>
          </div>
          {view === "edit" && <p className="muted inv-small">Drag on the page to add a box. Select a box to remove it. {boxes.length} box{boxes.length === 1 ? "" : "es"} in total ({here.length} on this page).</p>}
          <div className="mask-stage" ref={stage} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={e => e.preventDefault()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={`${imgKey}-${page}-${view}`} src={`${API}/${id}/pages/${page}${q}`} alt={`Page ${page} of ${st.document.title}`} draggable={false} />
            {view === "edit" && here.map(({ b, i }) => (
              <button key={i} type="button" className={`mask-box is-${b.source}${sel === i ? " is-selected" : ""}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                aria-label={`${b.source === "auto" ? "Elena" : "Manual"} box ${i + 1}${sel === i ? ", selected" : ""}`} aria-pressed={sel === i} onPointerDown={e => e.stopPropagation()} onClick={() => setSel(sel === i ? null : i)} />
            ))}
            {draft && <span className="mask-box is-draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />}
          </div>
        </section>

        <aside className="mask-side" aria-label="Masking tools">
          <div className="sr-card">
            <h2>Elena&apos;s auto-mask</h2>
            <p className="muted inv-small">Finds street addresses, unit and lot numbers, plan references, PO boxes and suburb/state/postcode, plus your extra terms. Your manual boxes are kept.</p>
            <label className="sr-field">Extra words to hide (one per line, e.g. the exact address or building name)
              <textarea value={terms} onChange={e => { setTerms(e.target.value); setDirty(true); }} rows={3} maxLength={2000} />
            </label>
            <button type="button" className="secondary" disabled={busy} onClick={() => void run({ action: "auto" }, "Elena's auto-mask ran again. Review the boxes.")}>Run auto-mask</button>
          </div>
          <div className="sr-card">
            <h2>Selected box</h2>
            {sel !== null && boxes[sel] ? (
              <>
                <p className="muted inv-small">{boxes[sel]!.source === "auto" ? "Found by Elena" : "Drawn by hand"}, page {boxes[sel]!.page}.</p>
                <button type="button" className="secondary danger" onClick={() => remove(sel)}>Remove this box</button>
              </>
            ) : <p className="muted inv-small">Select a box on the page to remove it.</p>}
          </div>
          <div className="sr-card">
            <h2>Save and confirm</h2>
            <label className="mask-check"><input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} /> Confirm even if some address-like text is not covered (I checked it is not an address)</label>
            <div className="sr-actions">
              <button type="button" className="secondary" disabled={busy || !dirty} onClick={() => void save(false)}>Save draft</button>
              <button type="button" disabled={busy} onClick={() => void save(true)}>Confirm masking</button>
            </div>
            {dirty && <p className="muted inv-small" role="status">You have unsaved changes.</p>}
          </div>
        </aside>
      </div>
    </main>
  );
}
