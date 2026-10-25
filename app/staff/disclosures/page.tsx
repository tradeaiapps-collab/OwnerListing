"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

type PropertyType = "house" | "unit" | "townhouse" | "land" | "office" | "retail" | "industrial" | "warehouse" | "hospitality" | "other";
const PROPERTY_TYPES: PropertyType[] = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const STATES = ["QLD", "WA", "NSW", "VIC", "SA", "TAS", "ACT", "NT"];

interface Item { key: string; label: string; description: string; legalRef: string; propertyTypes?: PropertyType[]; notApplicableAllowed: boolean }
interface Version {
  id: string; jurisdiction: string; transactionType: "sale" | "rent"; useClass: "residential" | "commercial"; version: number;
  items: Item[]; status: "draft" | "approved" | "retired"; note: string; createdBy: string | null; createdAt: string; approvedBy: string | null; approvedAt: string | null;
}
type Combo = { jurisdiction: string; transactionType: "sale" | "rent"; useClass: "residential" | "commercial" };
const comboKey = (c: Combo) => `${c.jurisdiction}:${c.transactionType}:${c.useClass}`;
const COMBOS: Combo[] = STATES.flatMap(j => (["sale", "rent"] as const).flatMap(tx => (["residential", "commercial"] as const).map(u => ({ jurisdiction: j, transactionType: tx, useClass: u }))));
const blankItem = (): Item => ({ key: "", label: "", description: "", legalRef: "", notApplicableAllowed: false });

function ItemsTable({ items }: { items: Item[] }) {
  if (items.length === 0) return <p className="muted">No disclosures required for this combination.</p>;
  return (
    <ul className="plain-list">
      {items.map(i => (
        <li key={i.key}>
          <strong>{i.label}</strong> <code>{i.key}</code>{i.notApplicableAllowed ? " · can be not applicable" : ""}
          {i.propertyTypes ? ` · only ${i.propertyTypes.join(", ")}` : ""}
          <br /><span>{i.description}</span><br /><small className="muted">{i.legalRef}</small>
        </li>
      ))}
    </ul>
  );
}

/** Editor for a new draft: one block per item. Starts from the newest version so a change is a small edit. */
function DraftEditor({ combo, start, onDone }: { combo: Combo; start: Item[]; onDone: (msg: string) => void }) {
  const [items, setItems] = useState<Item[]>(start.map(i => ({ ...i })));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const set = (n: number, patch: Partial<Item>) => setItems(items.map((it, i) => (i === n ? { ...it, ...patch } : it)));
  const toggleType = (n: number, t: PropertyType) => {
    const cur = items[n]!.propertyTypes ?? [];
    const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
    const { propertyTypes: _drop, ...rest } = items[n]!;
    setItems(items.map((it, i) => (i === n ? (next.length ? { ...rest, propertyTypes: next } : rest) : it)));
  };
  async function save() {
    setError("");
    const res = await postStaff("/api/staff/disclosures", { ...combo, items, note });
    if (res.ok) onDone(`Draft version ${String(res.data["version"])} saved. Someone else must approve it before it applies.`);
    else setError(String(res.data["error"] ?? "Could not save."));
  }
  return (
    <section className="panel">
      <h3>New draft</h3>
      {items.map((it, n) => (
        <fieldset key={n} className="form-section stack">
          <legend>Item {n + 1}</legend>
          <label>Key (never rename an existing key) <input value={it.key} onChange={e => set(n, { key: e.target.value })} placeholder="qld_example_key" /></label>
          <label>Label <input value={it.label} onChange={e => set(n, { label: e.target.value })} /></label>
          <label>What the owner must provide <textarea rows={3} value={it.description} onChange={e => set(n, { description: e.target.value })} /></label>
          <label>Legal reference <input value={it.legalRef} onChange={e => set(n, { legalRef: e.target.value })} /></label>
          <label><input type="checkbox" checked={it.notApplicableAllowed} onChange={e => set(n, { notApplicableAllowed: e.target.checked })} /> Owner may say it does not apply (Compliance still checks)</label>
          <div>Only for these property types (none ticked = all):{" "}
            {PROPERTY_TYPES.map(t => (
              <label key={t} className="inline-check"><input type="checkbox" checked={it.propertyTypes?.includes(t) ?? false} onChange={() => toggleType(n, t)} /> {t}</label>
            ))}
          </div>
          <div><button type="button" className="secondary" onClick={() => setItems(items.filter((_, i) => i !== n))}>Remove item</button></div>
        </fieldset>
      ))}
      <div className="actions"><button type="button" className="secondary" onClick={() => setItems([...items, blankItem()])}>Add item</button></div>
      <label>What changed and the source (required, 10 to 1000 characters)
        <textarea className="staff-reason" value={note} onChange={e => setNote(e.target.value)} />
      </label>
      <div className="actions"><button type="button" onClick={() => void save()}>Save draft</button></div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * Compliance screen for each state's required disclosures. Versions are drafted, then approved by a different person; approving
 * makes the version the publish requirement and retires the previous one. A combination with no approved version cannot publish.
 */
export default function StaffDisclosures() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [me, setMe] = useState("");
  const [can, setCan] = useState({ edit: false, approve: false });
  const [combo, setCombo] = useState<Combo>(COMBOS[0]!);
  const [editing, setEditing] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/disclosures").catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setVersions(b.versions); setMe(b.me); setCan(b.can);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byCombo = useMemo(() => {
    const m = new Map<string, Version[]>();
    for (const v of versions) m.set(comboKey(v), [...(m.get(comboKey(v)) ?? []), v]);
    return m;
  }, [versions]);
  const list = byCombo.get(comboKey(combo)) ?? [];
  const approved = list.find(v => v.status === "approved");

  async function approve(v: Version) {
    setMessage("");
    const res = await postStaff(`/api/staff/disclosures/${v.id}/approve`, { reason: reasons[v.id] ?? "" });
    setMessage(res.ok ? `Version ${v.version} approved. It now applies to new publishes.` : String(res.data["error"] ?? "Failed."));
    if (res.ok) await load();
  }

  return (
    <main>
      <h1>Disclosure requirements</h1>
      <p><a href="/staff">Back to staff</a> · <a href="/staff/disclosures/reviews">Evidence review queue</a></p>
      <p className="muted">Listings publish only where a version is approved. Published listings keep the version they passed. Legislation here is a starting map, not legal advice: approve only what counsel has confirmed.</p>
      {message && <p role="alert">{message}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>State</th><th>Sale or rent</th><th>Use</th><th>Approved</th><th>Drafts</th><th></th></tr></thead>
          <tbody>
            {COMBOS.map(c => {
              const vs = byCombo.get(comboKey(c)) ?? [];
              const a = vs.find(v => v.status === "approved");
              return (
                <tr key={comboKey(c)} aria-selected={comboKey(c) === comboKey(combo)}>
                  <td>{c.jurisdiction}</td><td>{c.transactionType}</td><td>{c.useClass}</td>
                  <td>{a ? `v${a.version}` : <span className="badge badge-rejected">None: blocked</span>}</td>
                  <td>{vs.filter(v => v.status === "draft").length}</td>
                  <td><button type="button" className="secondary" onClick={() => { setCombo(c); setEditing(false); }}>Open</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>{combo.jurisdiction} {combo.transactionType} ({combo.useClass})</h2>
      {can.edit && !editing && <p><button type="button" onClick={() => setEditing(true)}>Draft a new version</button></p>}
      {editing && <DraftEditor key={comboKey(combo)} combo={combo} start={(list[0]?.items ?? [])} onDone={m => { setEditing(false); setMessage(m); void load(); }} />}
      {list.length === 0 && <p className="muted">No versions yet. Publishing is blocked for this combination.</p>}
      <ul className="card-list">
        {list.map(v => (
          <li key={v.id} className="card">
            <h3>Version {v.version} <span className={`badge ${v.status === "approved" ? "badge-accepted" : v.status === "draft" ? "badge-under_review" : ""}`}>{v.status}</span></h3>
            <p className="muted">{v.note} · drafted {new Date(v.createdAt).toLocaleDateString("en-AU")}{v.createdBy === null ? " (seeded)" : ""}{v.approvedAt ? ` · approved ${new Date(v.approvedAt).toLocaleDateString("en-AU")}` : ""}</p>
            <ItemsTable items={v.items} />
            {v.status === "draft" && can.approve && (v.createdBy === me ? <p className="muted">You drafted this, so someone else must approve it.</p> : (
              <form className="stack" onSubmit={e => e.preventDefault()}>
                <label>Approval reason, for example the counsel advice it rests on (required)
                  <textarea className="staff-reason" value={reasons[v.id] ?? ""} onChange={e => setReasons({ ...reasons, [v.id]: e.target.value })} />
                </label>
                <div className="actions"><button type="button" onClick={() => void approve(v)}>{approved ? `Approve and retire v${approved.version}` : "Approve"}</button></div>
              </form>
            ))}
          </li>
        ))}
      </ul>
    </main>
  );
}
