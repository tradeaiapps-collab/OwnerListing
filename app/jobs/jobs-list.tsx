"use client";
import { useEffect, useState, type ReactNode } from "react";
import "../styles/agent-marketplace.css";
import "../styles/contractors.css";
import { JobActions, JobFacts, StatusPill, jobNo, type Job } from "./jobs-ui";

const GROUPS: [string, (j: Job) => boolean, (role: string) => string][] = [
  ["offers", j => j.status === "proposed", r => (r === "contractor" ? "Offers waiting for your answer" : "Offers waiting for the contractor")],
  ["active", j => j.status === "approved", () => "Accepted and in progress"],
  ["done", j => j.status === "completed", () => "Completed"],
  ["closed", j => j.status === "cancelled", () => "Rejected or cancelled"]
];

/** The jobs screen. `focus` puts the contractor's incoming offers first and links to their page. */
export function JobsList({ focus }: { focus: "contractor" | "all" }): ReactNode {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/jobs");
        if (r.status === 401) { setError("Sign in to see your jobs."); return; }
        if (!r.ok) throw new Error();
        setJobs((await r.json()).jobs);
      } catch { setError("Could not load your jobs."); }
    })();
  }, []);
  const shown = (jobs ?? []).filter(j => focus === "all" || j.role === "contractor");
  const replace = (n: Job) => setJobs(list => (list ?? []).map(j => (j.id === n.id ? n : j)));
  return (
    <main className="ma cm">
      <header>
        <h1>{focus === "contractor" ? "Your jobs" : "Jobs"}</h1>
        <p className="muted" style={{ margin: 0 }}>{focus === "contractor" ? <>Offers from owners, with a number for each job. <a href="/contractor/profile">Your contractor page</a></> : <>Every job has a number. <a href="/contractors">Find a contractor</a></>}</p>
      </header>
      {error && <p className="ma-state ma-error" role="alert">{error}</p>}
      {!error && jobs === null && <p className="ma-state" role="status">Loading…</p>}
      {jobs && shown.length === 0 && <p className="ma-state">{focus === "contractor" ? "No job offers yet. Make sure your page is public and your service areas are set." : "No jobs yet. Book a photographer, inspector or other trade from a contractor page."}</p>}
      {GROUPS.map(([key, test, title]) => {
        const items = shown.filter(test);
        if (items.length === 0) return null;
        return (
          <section key={key} className="ma-section" aria-labelledby={`g-${key}`}>
            <h2 id={`g-${key}`}>{title(focus === "contractor" ? "contractor" : items[0]!.role)} ({items.length})</h2>
            <ul className="cm-jobs">{items.map(j => (
              <li key={j.id} className="cm-job">
                <div className="cm-job-head"><span className="cm-num">{jobNo(j.jobNumber)}</span><StatusPill j={j} /></div>
                <h3><a href={`/jobs/${j.id}`}>{j.address}</a></h3>
                <JobFacts j={j} />
                {(j.status === "proposed" || j.status === "approved") && <JobActions job={j} onChange={replace} />}
                <div className="cm-actions"><a className="button secondary" href={`/jobs/${j.id}`}>Open job</a>{(j.status === "approved" || j.status === "completed") && <a className="button secondary" href={`/jobs/${j.id}/chat`}>Chat</a>}</div>
              </li>
            ))}</ul>
          </section>
        );
      })}
    </main>
  );
}
