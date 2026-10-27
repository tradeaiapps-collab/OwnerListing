import type { ReactNode } from "react";
import type { CardPhoto } from "../../src/domain/listing-photos";
import { aud, label, type Project } from "./ui";

/** Card tag wording, so the stage "approved" (plans approved) never reads like the review status. */
export const STAGE_TAG: Record<string, string> = { concept: "Concept stage", planning: "In planning", approved: "Plans approved", construction: "Under construction", completed: "Completed" };

export type CardProject = Pick<Project, "id" | "title" | "location" | "jurisdiction" | "projectType" | "summary" | "stage" | "fundingTargetCents" | "minimumTicketCents" | "issuerName"> & { photo?: CardPhoto };

/**
 * One project card (browse and "My posted projects"): cover photo or placeholder with the stage tag and photo count,
 * type, title, place, a two-line summary, and the indicative figures. `children` go in the footer (status, actions).
 */
export function ProjectCard({ p, children }: { p: CardProject; children?: ReactNode }) {
  const cover = p.photo?.cover;
  return (
    <li className="pcard">
      <a className="pcard-media" href={`/investments/${p.id}`} tabIndex={-1} aria-hidden="true">
        {cover
          ? <img src={`/api/investments/photos/${cover.id}`} srcSet={cover.srcSet || undefined} sizes="(min-width: 960px) 380px, (min-width: 600px) 50vw, 100vw"
              width={cover.width} height={cover.height} alt="" loading="lazy" decoding="async" />
          : <span className="pcard-ph" />}
        <span className="pcard-tag">{STAGE_TAG[p.stage] ?? label(p.stage)}</span>
        {(p.photo?.photoCount ?? 0) > 1 && <span className="pcard-count">{p.photo!.photoCount} photos</span>}
      </a>
      <div className="pcard-body">
        <p className="pcard-eyebrow">{label(p.projectType)}</p>
        <h2 className="pcard-title"><a href={`/investments/${p.id}`}>{p.title}</a></h2>
        <p className="pcard-where">{p.location}, {p.jurisdiction}</p>
        <p className="pcard-summary">{p.summary}</p>
        <dl className="pcard-figs">
          <div><dt>Indicative target</dt><dd>{aud(p.fundingTargetCents)}</dd></div>
          <div><dt>Minimum</dt><dd>{aud(p.minimumTicketCents)}</dd></div>
        </dl>
        <p className="pcard-issuer">Issuer: {p.issuerName}</p>
        {children && <div className="pcard-foot">{children}</div>}
      </div>
    </li>
  );
}
