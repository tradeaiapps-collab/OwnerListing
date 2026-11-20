"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import "../../styles/agent-marketplace.css";
import "../../styles/contractors.css";
import { JSON_HEADERS, Stars } from "../../contractors/ui";
import { JobActions, JobFacts, StatusPill, jobNo, type Job } from "../jobs-ui";

type Doc = { id: string; kind: string; status: string };
const KINDS: Record<string, [string, string][]> = {
  photographer: [["photo", "Photo"], ["video", "Video"], ["floorplan", "Floor plan"]],
  inspector: [["building_inspection", "Building inspection report"], ["pest_report", "Pest report"]],
  pest_control: [["pest_report", "Pest report"], ["photo", "Photo"]],
  other: [["photo", "Photo"], ["other", "Report or document"]]
};

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [error, setError] = useState("");
  const [up, setUp] = useState({ kind: "", busy: false, msg: "", ok: false });
  const [rv, setRv] = useState({ rating: 0, body: "", msg: "" });

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/jobs/${id}`);
      if (r.status === 401) { setError("Sign in to see this job."); return; }
      if (!r.ok) { setError(r.status === 404 ? "Job not found." : "Could not load this job."); return; }
      const j: Job = (await r.json()).job;
      setJob(j);
      setUp(u => ({ ...u, kind: u.kind || KINDS[j.kind]?.[0]?.[0] || "photo" }));
      const d = await fetch(`/api/listings/${j.listingId}/documents`);
      if (d.ok) setDocs((await d.json()).documents ?? []);
    } catch { setError("Could not load this job."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!job) return;
    const form = e.currentTarget, file = new FormData(form).get("file");
    if (!(file instanceof File) || file.size === 0) { setUp(u => ({ ...u, msg: "Choose a file first.", ok: false })); return; }
    const data = new FormData(); data.set("file", file); data.set("kind", up.kind); data.set("visibility", "parties");
    setUp(u => ({ ...u, busy: true, msg: "" }));
    try {
      const r = await fetch(`/api/listings/${job.listingId}/documents`, { method: "POST", body: data, credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      setUp(u => ({ ...u, busy: false, ok: r.ok, msg: r.ok ? "Added to the listing. The owner can see it." : d.error ?? "Could not upload that file." }));
      if (r.ok) { form.reset(); void load(); }
    } catch { setUp(u => ({ ...u, busy: false, ok: false, msg: "Could not upload that file." })); }
  }
  async function review(e: FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/jobs/${id}/review`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ rating: rv.rating, body: rv.body }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) setJob({ ...d.job, role: "owner" }); else setRv(v => ({ ...v, msg: d.error ?? "Could not save your feedback." }));
  }

  if (error) return <main className="ma cm"><p className="ma-state ma-error" role="alert">{error} <a href="/jobs">All jobs</a></p></main>;
  if (!job) return <main className="ma cm"><p className="ma-state" role="status">Loading…</p></main>;
  const mine = job.role === "contractor", num = jobNo(job.jobNumber);
  const mineKinds = KINDS[job.kind] ?? KINDS["other"]!;
  const files = docs.filter(d => d.status === "active" && mineKinds.some(k => k[0] === d.kind));
  return (
    <main className="ma cm">
      <a href={mine ? "/contractor/jobs" : "/jobs"} className="muted">← Jobs</a>
      <header className="ma-profile-head">
        <div className="cm-job-head"><span className="cm-num">{num}</span><StatusPill j={job} /></div>
        <h1>{job.address}</h1>
        <JobFacts j={job} />
        {job.contractorNo && !mine && <p style={{ margin: 0 }}><a href={`/contractors/${job.contractorNo}`}>See {job.contractorName}&apos;s page</a></p>}
      </header>

      {(job.status === "proposed" || job.status === "approved") && <section className="ma-section" aria-labelledby="j-act"><h2 id="j-act">What happens next</h2>
        <p className="cm-note">{mine ? (job.status === "proposed" ? "Accept the job, reject it with a reason, or suggest a time that suits you." : "Add your photos or reports below, then mark the job as done.") : job.status === "proposed" ? "Waiting for the contractor to answer. You will be notified." : job.contractorDoneAt ? "The contractor says the job is done. Check the files, then confirm it is complete." : "The contractor is on the job. You can chat with them and agree a time."}</p>
        <JobActions job={job} onChange={setJob} />
      </section>}

      <section className="ma-section" aria-labelledby="j-files"><h2 id="j-files">Photos and reports for this job</h2>
        {files.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing added yet.</p> : <ul className="cm-files">{files.map(f => <li key={f.id}><span>{mineKinds.find(k => k[0] === f.kind)?.[1] ?? f.kind}</span><a href={`/api/documents/${f.id}/file`}>Download</a></li>)}</ul>}
        {mine && job.status === "approved" && (
          <>
            <form className="cm-book" onSubmit={e => void upload(e)}>
              <label className="field"><span>Type</span><select value={up.kind} onChange={e => setUp({ ...up, kind: e.target.value })}>{mineKinds.map(k => <option key={k[0]} value={k[0]}>{k[1]}</option>)}</select></label>
              <label className="field"><span>File (photos, video or PDF)</span><input type="file" name="file" accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf" required /></label>
              <div className="cm-actions"><button type="submit" disabled={up.busy}>{up.busy ? "Uploading…" : "Upload"}</button></div>
              {up.msg && <p role="status" className={up.ok ? "ma-ok" : "ma-error"}>{up.msg}</p>}
            </form>
            <p className="cm-note"><strong>Or send them by email.</strong> Reply to any email about this job, or send a new one with <strong>{num}</strong> in the subject and the files attached, from the email address on your account. We run the same type check and virus scan, add the files to the listing and tell the owner.</p>
          </>
        )}
      </section>

      {(job.status === "approved" || job.status === "completed") && <p><a className="button secondary" href={`/jobs/${job.id}/chat`}>Open job chat</a></p>}

      {job.status === "completed" && (
        <section className="ma-section" aria-labelledby="j-rev"><h2 id="j-rev">Feedback</h2>
          {job.review ? <><Stars value={job.review.rating} />{job.review.body && <p style={{ margin: 0 }}>{job.review.body}</p>}</>
            : mine ? <p className="muted" style={{ margin: 0 }}>The owner can rate this job. It appears on your page.</p> : (
              <form className="ma-form" onSubmit={e => void review(e)}>
                <fieldset className="ma-star-input"><legend className="muted">Your rating</legend>
                  {[1, 2, 3, 4, 5].map(n => <label key={n} className={n <= rv.rating ? "on" : ""}><input type="radio" name="rating" value={n} checked={rv.rating === n} onChange={() => setRv({ ...rv, rating: n })} /><span aria-hidden="true">★</span><span className="sr-only">{n} star{n === 1 ? "" : "s"}</span></label>)}
                </fieldset>
                <label className="field"><span>Your feedback (optional)</span><textarea rows={4} maxLength={1000} value={rv.body} onChange={e => setRv({ ...rv, body: e.target.value })} /></label>
                {rv.msg && <p role="alert" className="ma-error">{rv.msg}</p>}
                <div className="cm-actions"><button type="submit" disabled={rv.rating === 0}>Send feedback</button></div>
              </form>
            )}
        </section>
      )}
    </main>
  );
}
