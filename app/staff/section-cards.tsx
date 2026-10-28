import { groupSections } from "../../src/domain/admin-nav";
import type { StaffSection } from "../../src/domain/staff-admin";
import { AdminIcon } from "../admin-icons";

/** Staff screens as grouped cards (icon, name, one-line description). `compact` drops the descriptions. */
export function SectionCards({ sections, compact = false, headingLevel = 2 }: { sections: readonly StaffSection[]; compact?: boolean; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={compact ? "section-groups compact" : "section-groups"}>
      {groupSections(sections).map(g => (
        <section key={g.key} className="section-group" aria-labelledby={`sg-${g.key}`}>
          <H id={`sg-${g.key}`} className="section-group-title">{g.label}<span className="section-group-count">{g.links.length}</span></H>
          <ul className="section-cards">
            {g.links.map(l => (
              <li key={l.href}>
                <a className="section-card" href={l.href}>
                  <span className="section-card-icon"><AdminIcon name={l.icon} size={22} /></span>
                  <span className="section-card-text">
                    <span className="section-card-name">{l.label}</span>
                    {!compact && l.blurb && <span className="section-card-blurb">{l.blurb}</span>}
                  </span>
                  <span className="section-card-go" aria-hidden="true"><AdminIcon name="arrow" size={18} /></span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
