"use client";
import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ACCOUNT_MENU, activeAccountItem } from "../../src/domain/account-menu";
import "../styles/account.css";

/** Account area frame: grouped left menu on wide screens, a collapsible menu on phones. */
export default function AccountShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/settings";
  const active = activeAccountItem(path);
  const [open, setOpen] = useState(false);
  return (
    <div className="acct">
      <nav className="acct-nav" aria-label="Account">
        <button type="button" className="acct-toggle" aria-expanded={open} aria-controls="acct-menu" onClick={() => setOpen(!open)}>
          <span>{active?.label ?? "Account"}</span><span aria-hidden="true">{open ? "▲" : "▼"}</span>
        </button>
        <div id="acct-menu" className="acct-menu" data-open={open}>
          {ACCOUNT_MENU.map(g => (
            <section key={g.id} aria-labelledby={`acct-g-${g.id}`}>
              <h2 id={`acct-g-${g.id}`}>{g.title}</h2>
              <ul>
                {g.items.map(it => (
                  <li key={it.id}><a href={it.href} aria-current={active?.id === it.id ? "page" : undefined}>{it.label}</a></li>
                ))}
              </ul>
            </section>
          ))}
          <a className="acct-delete" href="/settings/delete">Delete account</a>
        </div>
      </nav>
      <div className="acct-body">{children}</div>
    </div>
  );
}
