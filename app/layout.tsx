import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "OwnerListing", description: "Internal build: not for public use" };
export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <a className="brand" href="/">OwnerListing</a>
            <nav className="site-nav" aria-label="Main">
              <a href="/listings">Browse</a>
              <a href="/listings/new">List a property</a>
              <a href="/listings/mine">My listings</a>
              <a href="/buyer/saved-searches">Saved searches</a>
            </nav>
          </div>
        </header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
