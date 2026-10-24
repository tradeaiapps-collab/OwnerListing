import type { ReactNode } from "react";
import "./globals.css";
import SiteNav from "./site-nav";
import ThemePreviewBridge from "./theme-preview-bridge";
import "./styles/a11y.css";
import "./styles/theme.css";
import { appOriginFor, readAppMode } from "../src/config/app-mode";
import { assetUrl, buildThemeCss, fontStylesheetUrl } from "../src/domain/site-theme";
import { getRequestTheme } from "../src/server/request-theme";
import { brandFor } from "../src/server/site-theme";

const admin = readAppMode() === "admin";

const getTheme = getRequestTheme;

export async function generateMetadata() {
  const t = await getTheme();
  const brand = brandFor(t.settings);
  const fav = t.settings.brand.favicon;
  const icons = fav ? { icons: { icon: assetUrl("favicon", fav, t.previewToken ?? undefined) } } : {};
  const robots = admin || t.source === "draft" ? { robots: { index: false, follow: false } } : {};
  return admin
    ? { title: { default: `${brand.name} Admin`, template: `%s | ${brand.name} Admin` }, description: "Staff only", ...robots, ...icons }
    : { title: { default: brand.name, template: `%s | ${brand.name}` }, description: "Internal build: not for public use", ...robots, ...icons };
}
export const viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTheme();
  const { settings } = t;
  const brand = brandFor(settings);
  const fontUrl = fontStylesheetUrl([settings.typography.bodyFont, settings.typography.headingFont]);
  const tok = t.previewToken ?? undefined;
  const light = settings.brand.logoLight ?? settings.brand.logoDark;
  const dark = settings.brand.logoDark ?? settings.brand.logoLight;
  const logo = light && dark ? (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={assetUrl("logo-dark", dark, tok)} />
      <img className="brand-logo" src={assetUrl("logo-light", light, tok)} alt={admin ? "" : brand.name} />
    </picture>
  ) : null;
  const footer = settings.footer;
  const bridgeOrigin = t.source === "draft" ? appOriginFor(admin ? "admin" : "all") : null;

  return (
    <html lang="en-AU">
      <head>
        {fontUrl && <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />}
        {fontUrl && <link id="site-theme-font" rel="stylesheet" href={fontUrl} />}
        <style id="site-theme" dangerouslySetInnerHTML={{ __html: buildThemeCss(settings) }} />
      </head>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {admin && <div className="admin-banner" role="note"><strong>Admin</strong> · staff only · {brand.name}</div>}
        <header className="site-header">
          <div className="site-header-inner">
            {admin ? (
              <>
                <a className="brand" href="/staff">{logo}{brand.name} Admin</a>
                <nav className="site-nav" aria-label="Admin">
                  <a href="/staff">Staff home</a>
                  <a href="/api/auth/google/start?as=staff">Sign in</a>
                </nav>
              </>
            ) : (
              <>
                <a className="brand" href="/">{logo ?? brand.name}</a>
                <SiteNav items={settings.navigation} iconStyle={settings.layout.iconStyle} />
              </>
            )}
          </div>
        </header>
        <div className="page" id="main-content" tabIndex={-1}>{children}</div>
        {(footer.text || footer.links.length > 0) && (
          <footer className="site-footer">
            <div className="site-footer-inner">
              {footer.text && <p>{footer.text}</p>}
              {footer.links.length > 0 && (
                <nav aria-label="Footer"><ul>{footer.links.map(l => <li key={`${l.label}|${l.href}`}><a href={l.href}>{l.label}</a></li>)}</ul></nav>
              )}
            </div>
          </footer>
        )}
        {bridgeOrigin && <ThemePreviewBridge allowedOrigin={bridgeOrigin} />}
      </body>
    </html>
  );
}
