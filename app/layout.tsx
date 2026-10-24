import type { ReactNode } from "react";
import "./globals.css";
import SiteNav from "./site-nav";
import "./styles/a11y.css";
import { readAppMode } from "../src/config/app-mode";
import { readBrand } from "../src/config/brand";

const brand = readBrand();
const admin = readAppMode() === "admin";

export const metadata = admin
  ? { title: { default: `${brand.name} Admin`, template: `%s | ${brand.name} Admin` }, description: "Staff only", robots: { index: false, follow: false } }
  : { title: { default: brand.name, template: `%s | ${brand.name}` }, description: "Internal build: not for public use" };
export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {admin && <div className="admin-banner" role="note"><strong>Admin</strong> · staff only · {brand.name}</div>}
        <header className="site-header">
          <div className="site-header-inner">
            {admin ? (
              <>
                <a className="brand" href="/staff">{brand.name} Admin</a>
                <nav className="site-nav" aria-label="Admin">
                  <a href="/staff">Staff home</a>
                  <a href="/api/auth/google/start?as=staff">Sign in</a>
                </nav>
              </>
            ) : (
              <>
                <a className="brand" href="/">{brand.name}</a>
                <SiteNav />
              </>
            )}
          </div>
        </header>
        <div className="page" id="main-content" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
