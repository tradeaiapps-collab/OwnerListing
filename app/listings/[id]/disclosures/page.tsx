"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../ui";
import { RatesEditor } from "../rates-editor";

interface Item {
  key: string; label: string; description: string; legalRef: string; notApplicableAllowed: boolean;
  state: "missing" | "submitted" | "verified" | "rejected"; notApplicable: boolean; evidenceDocumentId: string | null; reviewReason: string | null;
}
interface Doc { id: string; kind: string; status: string }

const STATE_TEXT: Record<Item["state"], [string, string]> = {
  missing: ["To do", "badge"],
  submitted: ["Waiting for Compliance", "badge badge-under_review"],
  verified: ["Verified", "badge badge-accepted"],
  rejected: ["Needs another look", "badge badge-rejected"]
};
const kindLabel = (k: string) => k.replace(/_/g, " ");

/** One required disclosure: choose the uploaded document that shows it, or say why it does not apply (where allowed). */
function DisclosureRow({ listingId, item, docs, editable, onSaved }: { listingId: string; item: Item; docs: Doc[]; editable: boolean; onSaved: () => void }) {
  const [mode, setMode] = useState<"evidence" | "na">(item.notApplicable ? "na" : "evidence");
  const [doc, setDoc] = useState(item.evidenceDocumentId ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, cls] = STATE_TEXT[item.state];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const body = mode === "na" ? { notApplicable: true, note } : { evidenceDocumentId: doc };
    try {
      const r = await fetch(`/api/listings/${listingId}/disclosures/${item.key}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) onSaved(); else setError(d.error ?? "Could not save.");
    } catch { setError("Could not save."); } finally { setBusy(false); }
  }

  return (
    <li className="card">
      <h2>{item.label} <span className={cls}>{label}</span></h2>
      <p>{item.description}</p>
      <p className="muted"><small>{item.legalRef}</small></p>
      {item.state === "rejected" && item.reviewReason && <p role="alert">Compliance: {item.reviewReason}</p>}
      {item.state === "submitted" && <p className="muted">{item.notApplicable ? "You said this does not apply." : "Your document is with Compliance."} You can change it until it is reviewed.</p>}
      {editable && item.state !== "verified" && (
        <form className="stack" onSubmit={save}>
          {item.notApplicableAllowed && (
            <fieldset className="actions">
              <label><input type="radio" checked={mode === "evidence"} onChange={() => setMode("evidence")} /> I have the document</label>
              <label><input type="radio" checked={mode === "na"} onChange={() => setMode("na")} /> This does not apply</label>
            </fieldset>
          )}
          {mode === "evidence" ? (
            docs.length === 0
              ? <p className="muted">Upload the document first on the <a href={`/listings/${listingId}/documents`}>documents page</a>.</p>
              : (
                <label>Document
                  <select value={doc} onChange={e => setDoc(e.target.value)} required>
                    <option value="" disabled>Choose a document</option>
                    {docs.map((d, i) => <option key={d.id} value={d.id}>{kindLabel(d.kind)} ({i + 1})</option>)}
                  </select>
                </label>
              )
          ) : (
            <label>Why it does not apply
              <input value={note} onChange={e => setNote(e.target.value)} minLength={5} maxLength={500} required placeholder="e.g. There is no pool on the property." />
            </label>
          )}
          <div><button type="submit" disabled={busy || (mode === "evidence" && !doc)}>{busy ? "Saving..." : "Send to Compliance"}</button></div>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </li>
  );
}

/**
 * Owner checklist of the disclosures their state requires before publishing. Each one is checked by Compliance; the listing
 * cannot publish until every item is verified.
 */
export default function ListingDisclosures() {
  const { id } = useParams<{ id: string }>();
  const [items, setItems] = useState<Item[] | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [editable, setEditable] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setNotice("");
    const r = await fetch(`/api/listings/${id}/required-disclosures`).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { setItems([]); setNotice(r?.status === 401 ? "Sign in to see this listing's disclosures." : d.error ?? "Could not load the disclosures."); return; }
    setItems(d.items); setEditable(d.editable);
    const dr = await fetch(`/api/listings/${id}/documents`).catch(() => null);
    if (dr?.ok) setDocs(((await dr.json()).documents as Doc[]).filter(x => x.status === "active" && !["photo", "photo_360", "video", "video_360"].includes(x.kind)));
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const done = items?.filter(i => i.state === "verified").length ?? 0;
  return (
    <main className="narrow">
      <h1>Required disclosures</h1>
      <p><a href={`/listings/${id}/edit`}>Back to the draft</a></p>
      {notice && <p role="status">{notice}</p>}
      {items === null && <p className="muted" role="status">Loading...</p>}
      {items && items.length > 0 && <p><strong>{done} of {items.length} verified.</strong> Your listing can be published once every item is verified.</p>}
      {items && items.length === 0 && !notice && <p>No disclosures are required for this listing.</p>}
      <ul className="card-list">
        {items?.map(i => <DisclosureRow key={`${i.key}-${i.state}`} listingId={id} item={i} docs={docs} editable={editable} onSaved={() => void load()} />)}
      </ul>
      <RatesEditor listingId={id} />
    </main>
  );
}
