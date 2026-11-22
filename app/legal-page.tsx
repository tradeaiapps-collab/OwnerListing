import type { ReactNode } from "react";
import { LEGAL_DRAFT_NOTICE, type LegalDoc } from "../src/domain/legal-pages";
import "./styles/legal.css";

/** Shared layout for the public legal pages: draft notice, contents list, numbered sections. */
export function LegalBody({ doc, children }: { doc: LegalDoc; children?: ReactNode }) {
  return (
    <>
      <h1>{doc.title}</h1>
      <p className="muted">Last updated {doc.updated}</p>
      <p className="legal-draft" role="note"><strong>Draft.</strong> {LEGAL_DRAFT_NOTICE}</p>
      <p>{doc.intro}</p>
      <nav className="legal-toc" aria-label="Contents">
        <ol>{doc.sections.map(s => <li key={s.id}><a href={`#${s.id}`}>{s.heading}</a></li>)}</ol>
      </nav>
      {doc.sections.map(s => (
        <section key={s.id} id={s.id} className="legal-section" aria-labelledby={`${s.id}-h`}>
          <h2 id={`${s.id}-h`}>{s.heading}</h2>
          {s.paragraphs.map(p => <p key={p}>{p}</p>)}
          {s.bullets && <ul>{s.bullets.map(b => <li key={b}>{b}</li>)}</ul>}
        </section>
      ))}
      {children}
    </>
  );
}

export default function LegalPage({ doc, children }: { doc: LegalDoc; children?: ReactNode }) {
  return <main className="legal"><LegalBody doc={doc}>{children}</LegalBody></main>;
}
