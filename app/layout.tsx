import type { ReactNode } from "react";
import "./globals.css";
import SiteNav from "./site-nav";
import "./styles/a11y.css";

export const metadata = { title: { default: "OwnerListing", template: "%s | OwnerListing" }, description: "Internal build: not for public use" };
export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <header className="site-header">
          <div className="site-header-inner">
            <a className="brand" href="/">OwnerListing</a>
            <SiteNav />
          </div>
        </header>
        <div className="page" id="main-content" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
