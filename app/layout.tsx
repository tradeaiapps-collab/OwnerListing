import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";
import GuideAssistant from "./guide-assistant";
import AdminShell from "./admin-shell";
import SiteNav from "./site-nav";
import ThemePreviewBridge from "./theme-preview-bridge";
import "./styles/a11y.css";
import { appOriginFor, readAppMode } from "../src/config/app-mode";
import { personaById } from "../src/domain/assistant-persona";
import { GUIDE_DISCLAIMER } from "../src/domain/guide-assistant";
import { assetUrl, buildThemeCss, fontStylesheetUrl } from "../src/domain/site-theme";
import { devLoginAllowed } from "../src/server/dev-login";
import { getLivePersona } from "../src/server/assistant-persona-db";
import { getLiveGuide } from "../src/server/guide-assistant-db";
import { getRequestTheme } from "../src/server/request-theme";
import { brandFor } from "../src/server/site-theme";

const admin = readAppMode() === "admin";
/** Footer columns used until an admin sets footer links at /staff/site (then those links replace the columns). */
const FOOTER_COLUMNS = [
  { title: "Buy or rent", links: [{ label: "Browse listings", href: "/listings" }, { label: "Saved searches", href: "/buyer/saved-searches" }, { label: "Verify your account", href: "/buyer/verification" }] },
  { title: "Owners", links: [{ label: "List your property", href: "/listings/new" }, { label: "Plans and fees", href: "/plans" }, { label: "My listings", href: "/listings/mine" }] },
  { title: "Help", links: [{ label: "How it works", href: "/#home-how" }, { label: "Questions", href: "/#home-faq" }, { label: "Dashboard", href: "/dashboard" }, { label: "Terms", href: "/terms" }] }
];

const getTheme = getRequestTheme;

export async function generateMetadata() {
  const t = await getTheme();
  const brand = brandFor(t.settings);
  const fav = t.settings.brand.favicon;
  const icons = fav ? { icons: { icon: assetUrl("favicon", fav, t.previewToken ?? undefined) } } : {};
  const robots = admin || t.source === "draft" ? { robots: { index: false, follow: false } } : {};
  return admin
    ? { title: { default: `${brand.name} Admin`, template: `%s | ${brand.name} Admin` }, description: "Staff only", ...robots, ...icons }
    : { title: { default: brand.name, template: `%s | ${brand.name}` }, description: `${brand.tagline}. List your own property, meet verified buyers and decide on every offer yourself.`, ...robots, ...icons };
}
export const viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTheme();
  const { settings } = t;
  const brand = brandFor(settings);
  const fontUrl = fontStylesheetUrl([settings.typography.bodyFont, settings.typography.headingFont]);
  const tok = t.previewToken ?? undefined;
  // The public site can be fixed to light in Site appearance; the staff console keeps following the device.
  const fixedLight = !admin && settings.layout.colourMode === "light";
  const light = settings.brand.logoLight ?? settings.brand.logoDark;
  const dark = settings.brand.logoDark ?? settings.brand.logoLight;
  const logo = light && dark ? (
    <picture>
      {!fixedLight && <source media="(prefers-color-scheme: dark)" srcSet={assetUrl("logo-dark", dark, tok)} />}
      <img className="brand-logo" src={assetUrl("logo-light", light, tok)} alt={admin ? "" : brand.name} />
    </picture>
  ) : null;
  const footer = settings.footer;
  const bridgeOrigin = t.source === "draft" ? appOriginFor(admin ? "admin" : "all") : null;
  const [guide, personaId] = admin ? [null, null] : await Promise.all([getLiveGuide(), getLivePersona()]);
  const persona = personaById(personaId);
  // "Sign in" goes to the local test kit's dev sign-in only where devLoginAllowed() holds (never in production); otherwise unchanged.
  const h = await headers();
  const devSignIn = !admin && devLoginAllowed({ url: `http://${h.get("host") ?? ""}/`, headers: { get: n => h.get(n) } });

  return (
    <html lang="en-AU" data-theme-mode={fixedLight ? "light" : undefined}>
      <head>
        {fontUrl && <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />}
        {fontUrl && <link id="site-theme-font" rel="stylesheet" href={fontUrl} />}
        <style id="site-theme" dangerouslySetInnerHTML={{ __html: buildThemeCss(settings) }} />
      </head>
      <body className={admin ? "admin-app" : undefined}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {admin ? (
          <AdminShell brand={brand.name} logo={logo} siteHref={appOriginFor("public")}>{children}</AdminShell>
        ) : (
          <>
            <header className="site-header">
              <div className="site-header-inner">
                <a className="brand" href="/">{logo ?? brand.name}</a>
                <SiteNav items={settings.navigation} iconStyle={settings.layout.iconStyle} {...(devSignIn ? { signInHref: "/dev-login" as const } : {})} />
              </div>
            </header>
            <div className="page" id="main-content" tabIndex={-1}>{children}</div>
            <footer className="site-footer">
              <div className="site-footer-inner">
                <div className="site-footer-brand">
                  <p className="site-footer-name">{brand.name}</p>
                  <p className="site-footer-tag">{brand.tagline}. Deposits go to the solicitor&apos;s trust account; we never hold your money.</p>
                </div>
                {footer.links.length > 0 ? (
                  <nav aria-label="Footer">
                    <ul>{footer.links.map(l => <li key={`${l.label}|${l.href}`}><a href={l.href}>{l.label}</a></li>)}</ul>
                  </nav>
                ) : (
                  <nav aria-label="Footer" className="site-footer-cols">
                    {FOOTER_COLUMNS.map(c => (
                      <div key={c.title}>
                        <h2>{c.title}</h2>
                        <ul>{c.links.map(l => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
                      </div>
                    ))}
                  </nav>
                )}
              </div>
              <div className="site-footer-base"><p>{footer.text || `© ${new Date().getFullYear()} ${brand.name}`}</p></div>
            </footer>
          </>
        )}
        {guide?.enabled && <GuideAssistant greeting={guide.greeting} chips={guide.chips} disclaimer={GUIDE_DISCLAIMER} persona={{ name: persona.name, icon: persona.icon }} />}
        {bridgeOrigin && <ThemePreviewBridge allowedOrigin={bridgeOrigin} />}
      </body>
    </html>
  );
}
