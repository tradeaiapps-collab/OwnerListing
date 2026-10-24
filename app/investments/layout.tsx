import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { INVESTMENT_DISCLOSURE } from "../../src/config/investment-disclosure";
import { getInvestmentDeps } from "../../src/server/investments-db";
import "../styles/investments.css";

export const metadata = { title: "Investor projects" };
// Read both keys on every request, so turning the module off takes effect at once.
export const dynamic = "force-dynamic";

/** Every investor page: 404 unless both keys are on, and the risk warning on top. */
export default async function Layout({ children }: { children: ReactNode }) {
  if (!(await getInvestmentDeps().moduleState()).live) notFound();
  return (
    <>
      <aside className="inv-disclaimer" role="note" aria-label={INVESTMENT_DISCLOSURE.title}>
        <strong>{INVESTMENT_DISCLOSURE.title}</strong>
        <p>{INVESTMENT_DISCLOSURE.text}</p>
        <small>Version {INVESTMENT_DISCLOSURE.version}</small>
      </aside>
      {children}
    </>
  );
}
