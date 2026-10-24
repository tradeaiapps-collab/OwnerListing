"use client";
import { use, useEffect, useState } from "react";
import ProjectForm from "../../project-form";
import type { Project } from "../../ui";

export default function EditProject({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<Project | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch(`/api/investments/projects/${id}`).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.mine) setP(d.project); else setError("Project not found.");
    }).catch(() => setError("Could not load."));
  }, [id]);
  return (
    <main>
      <h1>Edit project</h1>
      <p className="muted">Saving sends the project back to staff review. Investors cannot see it until it is approved again. Your posting terms stay as they were when you first posted.</p>
      {error && <p role="alert">{error}</p>}
      {p && <ProjectForm initial={p} />}
    </main>
  );
}
