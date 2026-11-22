"use client";
import { useState } from "react";
import { AU_JURISDICTIONS } from "../../src/domain/jurisdiction";
import { dollarsToCents } from "../../src/domain/listing-details";
import { PROJECT_STAGES, PROJECT_TYPES } from "../../src/domain/investor-projects";
import { label, send, type Project } from "./ui";

const TEXT: [keyof Project, string, number, boolean][] = [
  ["summary", "Summary", 4000, true], ["timeline", "Timeline", 2000, true], ["risks", "Key risks", 4000, true],
  ["structureDescription", "Structure (who owns what, how returns would work)", 4000, true]
];

/** New and edit share this form. Submitting always sends the project to staff review. */
export default function ProjectForm({ initial }: { initial?: Project }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const err = (k: string) => errors[k] ? <span className="inv-error">{errors[k]}</span> : null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({}); setError("");
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) ?? "");
    const target = dollarsToCents(s("target")), ticket = dollarsToCents(s("ticket"));
    if (target === undefined || ticket === undefined) { setError("Enter the amounts in whole dollars."); return; }
    const body = {
      title: s("title"), location: s("location"), jurisdiction: s("jurisdiction"), projectType: s("projectType"), stage: s("stage"),
      summary: s("summary"), timeline: s("timeline"), risks: s("risks"), structureDescription: s("structureDescription"),
      fundingTargetCents: target, minimumTicketCents: ticket, visibleTo: s("visibleTo"),
      issuerName: s("issuerName"), issuerLicenceBasis: s("issuerLicenceBasis"), issuerStatement: s("issuerStatement"),
      issuerAuthorisedConfirmed: fd.get("issuerAuthorisedConfirmed") === "on"
    };
    setBusy(true);
    const r = await send(initial ? `/api/investments/projects/${initial.id}` : "/api/investments/projects", initial ? "PUT" : "POST", body);
    setBusy(false);
    if (r.ok) { const pid = (r.data["project"] as { id: string }).id; window.location.assign(initial ? `/investments/${pid}` : `/investments/${pid}/photos?new=1`); }
    else { setError(String(r.data["error"] ?? "Could not save.")); setErrors((r.data["fields"] as Record<string, string>) ?? {}); }
  }

  const v = initial;
  return (
    <form className="inv-form" onSubmit={submit} noValidate>
      <fieldset>
        <legend>Project</legend>
        <label>Title<input name="title" defaultValue={v?.title} maxLength={120} required />{err("title")}</label>
        <label>Location (suburb or area)<input name="location" defaultValue={v?.location} maxLength={120} required />{err("location")}</label>
        <label>State or territory<select name="jurisdiction" defaultValue={v?.jurisdiction ?? "QLD"}>{AU_JURISDICTIONS.map(j => <option key={j}>{j}</option>)}</select>{err("jurisdiction")}</label>
        <label>Project type<select name="projectType" defaultValue={v?.projectType ?? PROJECT_TYPES[0]}>{PROJECT_TYPES.map(t => <option key={t} value={t}>{label(t)}</option>)}</select>{err("projectType")}</label>
        <label>Stage<select name="stage" defaultValue={v?.stage ?? PROJECT_STAGES[0]}>{PROJECT_STAGES.map(t => <option key={t} value={t}>{label(t)}</option>)}</select>{err("stage")}</label>
        {TEXT.map(([k, l, max]) => (
          <label key={k}>{l}<textarea name={k} defaultValue={v ? String(v[k]) : ""} rows={4} maxLength={max} required />{err(k)}</label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Indicative figures (nothing is collected)</legend>
        <label>Funding target (AUD)<input name="target" inputMode="decimal" defaultValue={v ? String(v.fundingTargetCents / 100) : ""} required />{err("fundingTargetCents")}</label>
        <label>Minimum amount per investor (AUD)<input name="ticket" inputMode="decimal" defaultValue={v ? String(v.minimumTicketCents / 100) : ""} required />{err("minimumTicketCents")}</label>
        <label>Who may see it
          <select name="visibleTo" defaultValue={v?.visibleTo ?? "wholesale_only"}>
            <option value="wholesale_only">Wholesale and sophisticated investors only (default)</option>
            <option value="all_verified">All verified investors, including retail</option>
          </select>{err("visibleTo")}
        </label>
      </fieldset>
      <fieldset>
        <legend>Issuer declaration</legend>
        <label>Who is offering (person or company and ABN/ACN)<input name="issuerName" defaultValue={v?.issuerName} maxLength={200} required />{err("issuerName")}</label>
        <label>Licence or exemption relied on (for example AFSL number, or the exemption)<textarea name="issuerLicenceBasis" defaultValue={v?.issuerLicenceBasis} rows={2} maxLength={500} required />{err("issuerLicenceBasis")}</label>
        <label>Anything else investors should know about the issuer (optional)<textarea name="issuerStatement" defaultValue={v?.issuerStatement} rows={2} maxLength={2000} />{err("issuerStatement")}</label>
        <label className="inv-check"><input type="checkbox" name="issuerAuthorisedConfirmed" />I confirm I am authorised to make this offer and to rely on the licence or exemption named above.</label>
        {err("issuerAuthorisedConfirmed")}
      </fieldset>
      <p className="muted">Staff review every project before any investor can see it. Any later edit sends it back to review. Documents (information memorandum) are not uploaded here yet: share them in the conversation only after staff approval.</p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Submit for review"}</button>
    </form>
  );
}
