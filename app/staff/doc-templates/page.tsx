"use client";
import { useEffect, useState } from "react";
import Breadcrumbs from "../../breadcrumbs";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";
import "../../styles/signing.css";

type Content = { fields: unknown[]; clauses: unknown[] };
type Version = { version: number; createdBy: string; createdAt: string; changeNote: string; live: boolean };
type Template = { id: string; key: string; title: string; category: string; liveVersion: number | null; latestVersion: number; latest: Content; versions: Version[] };
type View = { templates: Template[]; canEdit: boolean; canPublish: boolean };

const NEW_CONTENT: Content = { fields: [{ key: "example", label: "Example field", type: "text", required: true }], clauses: [{ id: "c1", heading: "Heading", text: "Clause text using {{example}}.", explanation: "Plain-English explanation the assistant reads out." }] };

/**
 * Contract, disclosure and agreement templates. A save is a new draft version; publishing makes a version live and needs a different
 * person from its author. The text is edited as JSON: fields to fill in, and clauses with a plain-English explanation each.
 */
export default function StaffDocTemplates() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [json, setJson] = useState("");
  const [change, setChange] = useState("");
  const [fresh, setFresh] = useState({ key: "", title: "", category: "agreement" });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch("/api/staff/doc-templates").catch(() => null);
    if (!r?.ok) { setError(loadError(r?.status ?? 0)); return; }
    setView(await r.json());
  };
  useEffect(() => { void load(); }, []);

  const send = async (body: unknown, ok: string) => {
    setBusy(true); setError(""); setNote(""); setProblems([]);
    const r = await postStaff("/api/staff/doc-templates", body);
    setBusy(false);
    if (r.ok) { setNote(ok); await load(); return true; }
    setError(String(r.data["error"] ?? "Could not save."));
    setProblems(Array.isArray(r.data["problems"]) ? (r.data["problems"] as string[]) : []);
    return false;
  };
  const parse = (): Content | null => { try { return JSON.parse(json) as Content; } catch { setError("The content is not valid JSON."); return null; } };
  const edit = (t: Template) => { setOpen(t.id); setJson(JSON.stringify(t.latest, null, 2)); setChange(""); setError(""); setProblems([]); setNote(""); };

  if (!view) return <main><Breadcrumbs trail={[{ label: "Staff", href: "/staff" }, { label: "Document templates" }]} /><h1>Document templates</h1>{error ? <p role="alert">{error}</p> : <p className="muted" role="status">Loading…</p>}</main>;

  return (
    <main>
      <Breadcrumbs trail={[{ label: "Staff", href: "/staff" }, { label: "Document templates" }]} />
      <h1>Document templates</h1>
      <p className="muted">Owners generate documents from the live version only. Counsel must review the wording before it is published, and you cannot publish a version you wrote. Documents already generated keep the version they were made from.</p>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
      {problems.length > 0 && <ul className="sg-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul>}

      {view.canEdit && view.templates.length === 0 && (
        <p><button type="button" disabled={busy} onClick={() => void send({ action: "install_starters" }, "Starter templates added as drafts.")}>Add the starter templates (drafts)</button></p>
      )}
      {view.templates.length === 0 && !view.canEdit && <p className="empty">No templates yet.</p>}

      <ul className="card-list">
        {view.templates.map(t => (
          <li key={t.id} className="sg-card">
            <strong>{t.title}</strong>
            <small className="muted sg-meta">{t.key} · {t.category} · {t.liveVersion ? `live: version ${t.liveVersion}` : "not live"} · latest: version {t.latestVersion}</small>
            <div className="sg-table-wrap">
              <table className="sg-table">
                <thead><tr><th scope="col">Version</th><th scope="col">Saved by</th><th scope="col">When</th><th scope="col">Note</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {t.versions.map(v => (
                    <tr key={v.version}>
                      <td>{v.version}{v.live ? " (live)" : ""}</td><td>{v.createdBy}</td><td>{new Date(v.createdAt).toLocaleString("en-AU")}</td><td>{v.changeNote}</td>
                      <td>{view.canPublish && !v.live && <button type="button" className="secondary" disabled={busy} onClick={() => void send({ action: "publish", templateId: t.id, version: v.version }, `Version ${v.version} of ${t.title} is now live.`)}>Publish</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {view.canEdit && open !== t.id && <div className="sg-actions"><button type="button" className="secondary" onClick={() => edit(t)}>Edit as a new version</button></div>}
            {view.canEdit && open === t.id && (
              <form className="stack" onSubmit={async e => { e.preventDefault(); const c = parse(); if (c && await send({ action: "save_version", templateId: t.id, baseVersion: t.latestVersion, content: c, note: change }, "Saved as a new draft version.")) setOpen(null); }}>
                <label>Content (JSON: fields and clauses)<textarea className="sg-code" value={json} onChange={e => setJson(e.target.value)} spellCheck={false} /></label>
                <label>What changed<input value={change} onChange={e => setChange(e.target.value)} maxLength={500} /></label>
                <div className="sg-actions"><button type="submit" disabled={busy}>Save new version</button><button type="button" className="secondary" onClick={() => setOpen(null)}>Close</button></div>
              </form>
            )}
          </li>
        ))}
      </ul>

      {view.canEdit && (
        <form className="stack" onSubmit={async e => { e.preventDefault(); if (await send({ action: "create", ...fresh, content: NEW_CONTENT }, "Template created as a draft. Edit it to add your wording.")) setFresh({ key: "", title: "", category: "agreement" }); }}>
          <h2>New template</h2>
          <div className="sg-row">
            <label>Key (lowercase, digits, underscores)<input value={fresh.key} onChange={e => setFresh({ ...fresh, key: e.target.value })} required pattern="[a-z0-9_]{3,40}" /></label>
            <label>Title<input value={fresh.title} onChange={e => setFresh({ ...fresh, title: e.target.value })} required minLength={3} maxLength={120} /></label>
            <label>Category<select value={fresh.category} onChange={e => setFresh({ ...fresh, category: e.target.value })}><option value="agreement">Agreement</option><option value="contract">Contract</option><option value="disclosure">Disclosure</option></select></label>
            <button type="submit" disabled={busy}>Create draft</button>
          </div>
        </form>
      )}
    </main>
  );
}
