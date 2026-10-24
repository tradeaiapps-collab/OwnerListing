"use client";
import { useEffect, useState } from "react";
import ProjectForm from "../project-form";

export default function NewProject() {
  const [terms, setTerms] = useState("");
  useEffect(() => {
    void fetch("/api/investments/posting-terms").then(r => (r.ok ? r.json() : null)).then(d => setTerms(d?.text ?? "")).catch(() => undefined);
  }, []);
  return (
    <main>
      <h1>Post a project</h1>
      <p className="muted">For verified owners and developers. Staff review every project before investors can see it.</p>
      {terms && <section className="panel"><h2>Platform terms for new projects</h2><p>{terms}</p></section>}
      <ProjectForm />
    </main>
  );
}
