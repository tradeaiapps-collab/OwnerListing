"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Info { title: string; pageCount: number; masked: boolean }

/**
 * Reads a project document inside the site: one flat image per page, fetched from the server after the access checks. The original
 * file is never sent, so there is nothing to download; the images are watermarked with the viewer's id and, for investors, have the
 * project's address burned out. `base` is the API prefix; `investorView` lets the owner or staff see what investors see.
 */
export function DocumentViewer({ docId, title, onClose, base = "/api/investments/documents", investorView = false }: {
  docId: string; title: string; onClose: () => void; base?: string; investorView?: boolean;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const q = investorView ? "?view=investor" : "";

  useEffect(() => {
    void fetch(`${base}/${docId}/pages`).then(async r => {
      if (r.ok) setInfo(await r.json());
      else setError(r.status === 401 ? "Sign in again to read this document." : r.status === 429 ? "Too many pages opened. Try again in a few minutes." : "This document is not available.");
    }).catch(() => setError("This document could not be loaded."));
  }, [base, docId]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    document.body.classList.add("doc-viewer-open");
    return () => { document.removeEventListener("keydown", key); document.body.classList.remove("doc-viewer-open"); opener?.focus?.(); };
  }, [onClose]);

  // A portal keeps the viewer full-screen even inside a card that has a transform or overflow.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  const pages = info ? Array.from({ length: info.pageCount }, (_, i) => i + 1) : [];
  if (!host) return null;
  return createPortal(
    <div className="doc-viewer" role="dialog" aria-modal="true" aria-label={`Document: ${title}`} onContextMenu={e => e.preventDefault()}>
      <header className="doc-viewer-bar">
        <div>
          <strong>{title}</strong>
          <span className="muted inv-small">{info ? `${info.pageCount} page${info.pageCount === 1 ? "" : "s"}` : ""}{info?.masked || investorView ? " · address hidden" : ""}</span>
        </div>
        <button type="button" className="secondary" ref={closeRef} onClick={onClose}>Close</button>
      </header>
      <p className="doc-viewer-note muted inv-small">Shown here only. Pages carry a watermark and cannot be downloaded from this site.</p>
      <div className="doc-viewer-pages">
        {error && <p role="alert" className="doc-viewer-msg">{error}</p>}
        {!info && !error && <p className="muted doc-viewer-msg" role="status">Loading…</p>}
        {pages.map(n => (
          <figure key={n} className="doc-page">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${base}/${docId}/pages/${n}${q}`} alt={`${title}, page ${n} of ${pages.length}`} loading={n > 2 ? "lazy" : "eager"} draggable={false}
              onError={e => { e.currentTarget.classList.add("is-failed"); }} />
            <span className="doc-page-shield" aria-hidden="true" />
            <figcaption className="muted inv-small">Page {n} of {pages.length}</figcaption>
          </figure>
        ))}
      </div>
    </div>,
    host
  );
}
