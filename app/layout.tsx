import type { ReactNode } from "react";
import "./globals.css";
import SiteNav from "./site-nav";

export const metadata = { title: "OwnerListing", description: "Internal build: not for public use" };
export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <a className="brand" href="/">OwnerListing</a>
            <SiteNav />
          </div>
        </header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
