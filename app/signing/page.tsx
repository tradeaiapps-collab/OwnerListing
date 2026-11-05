"use client";
import { useEffect, useState } from "react";
import Breadcrumbs from "../breadcrumbs";
import { STATUS_LABEL } from "./labels";
import "../styles/signing.css";

type Signer = { id: string; userId: string; roleLabel: string; status: "pending" | "signed" | "declined" };
type Doc = { id: string; listingTitle: string; ownerUserId: string; title: string; status: string; createdAt: string; signers: Signer[] };

/** Everything the signed-in person has to sign or has sent. */
export default function MyDocuments() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [viewer, setViewer] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/signing-documents").then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setDocs(d.documents); setViewer(d.viewerId); }
      else setError(r.status === 401 ? "Sign in to see your documents." : "Could not load your documents.");
    }).catch(() => setError("Could not load your documents."));
  }, []);

  const toSign = docs?.filter(d => d.status === "out_for_signature" && d.signers.some(s => s.userId === viewer && s.status === "pending")) ?? [];
  const rest = docs?.filter(d => !toSign.includes(d)) ?? [];
  const row = (d: Doc) => (
    <li key={d.id}>
      <strong><a href={`/signing/${d.id}`}>{d.title}</a></strong>
      <span><span className={`sg-badge is-${d.status}`}>{STATUS_LABEL[d.status] ?? d.status}</span></span>
      <small className="muted">{d.listingTitle} · {d.signers.filter(s => s.status === "signed").length} of {d.signers.length} signed · {new Date(d.createdAt).toLocaleDateString("en-AU")}</small>
    </li>
  );

  return (
    <main>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Documents" }]} />
      <h1>Documents</h1>
      {error && <p role="alert">{error}</p>}
      {!error && docs === null && <p className="muted" role="status">Loading…</p>}
      {docs && toSign.length > 0 && (<><h2>Waiting for your signature</h2><ul className="card-list">{toSign.map(row)}</ul></>)}
      {docs && (<><h2>All documents</h2>{rest.length === 0 ? <p className="empty">Nothing here yet. Documents an owner sends you to sign appear on this page.</p> : <ul className="card-list">{rest.map(row)}</ul>}</>)}
    </main>
  );
}
