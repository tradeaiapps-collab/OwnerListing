/** Shared breadcrumb trail. The last item is the current page (no link, aria-current). */
export default function Breadcrumbs({ trail }: { trail: readonly { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>
        {trail.map((t, i) => (
          <li key={`${t.label}-${i}`}>
            {t.href && i < trail.length - 1 ? <a href={t.href}>{t.label}</a> : <span aria-current="page">{t.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
