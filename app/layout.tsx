import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";
import GuideAssistant from "./guide-assistant";
import { ElenaContextTracker } from "./elena-context";
import AdminShell from "./admin-shell";
import SiteNav from "./site-nav";
import NavMemory from "./nav-memory";
import { THEME_INIT_SCRIPT } from "./theme-toggle";
import ThemePreviewBridge from "./theme-preview-bridge";
import "./styles/a11y.css";
import "./styles/inspections.css";
import "./styles/emergency.css";
import "./styles/rentals.css";
import "./styles/pwa.css";
import PwaRegister from "./pwa-register";
import { appOriginFor, readAppMode } from "../src/config/app-mode";
import { LOCALE_COOKIE } from "../src/domain/account-settings";
import { DEFAULT_LOCALE, LOCALES, isRtl } from "../src/domain/i18n";
import { personaById } from "../src/domain/assistant-persona";
import { GUIDE_DISCLAIMER } from "../src/domain/guide-assistant";
import { assetUrl, buildThemeCss, fontStylesheetUrl } from "../src/domain/site-theme";
import { tenantAssetUrl } from "../src/domain/white-label";
import { getLivePersona } from "../src/server/assistant-persona-db";
import { getLiveGuide } from "../src/server/guide-assistant-db";
import { getRequestTheme } from "../src/server/request-theme";
import { brandFor } from "../src/server/site-theme";

const admin = readAppMode() === "admin";
/** Footer columns used until an admin sets footer links at /staff/site (then those links replace the columns). */
const FOOTER_COLUMNS = [
  { title: "Buy or rent", links: [{ label: "Browse listings", href: "/listings" }, { label: "Saved searches", href: "/buyer/saved-searches" }, { label: "Verify your account", href: "/buyer/verification" }] },
  { title: "Owners", links: [{ label: "List your property", href: "/listings/new" }, { label: "Plans and fees", href: "/plans" }, { label: "Emergency contractors", href: "/emergency" }, { label: "My listings", href: "/listings/mine" }] },
  { title: "Help", links: [{ label: "How it works", href: "/#home-how" }, { label: "Questions", href: "/#home-faq" }, { label: "Dashboard", href: "/dashboard" }, { label: "Terms", href: "/terms" }] }
];

/** Always shown under the footer, whether or not an admin has replaced the footer links. */
const LEGAL_LINKS = [{ label: "Privacy", href: "/privacy" }, { label: "Terms", href: "/terms" }, { label: "Support", href: "/support" }, { label: "Get the app", href: "/get-the-app" }];

const getTheme = getRequestTheme;

export async function generateMetadata() {
  const t = await getTheme();
  const brand = brandFor(t.settings);
  const fav = t.settings.brand.favicon;
  const icons = fav ? { icons: { icon: t.tenantId ? tenantAssetUrl("favicon", fav) : assetUrl("favicon", fav, t.previewToken ?? undefined) } } : {};
  const robots = admin || t.source === "draft" ? { robots: { index: false, follow: false } } : {};
  return admin
    ? { title: { default: `${brand.name} Admin`, template: `%s | ${brand.name} Admin` }, description: "Staff only", ...robots, ...icons }
    : { title: { default: brand.name, template: `%s | ${brand.name}` }, description: `${brand.tagline}. List your own property, meet verified buyers and decide on every offer yourself.`, manifest: "/manifest.webmanifest", appleWebApp: { capable: true, title: brand.name, statusBarStyle: "black-translucent" as const }, applicationName: brand.name, formatDetection: { telephone: false }, ...robots, ...icons, icons: { ...("icons" in icons ? icons.icons : {}), apple: "/icons/apple-touch-icon.png" } };
}
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" as const, themeColor: "#14213d" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTheme();
  const { settings } = t;
  const brand = brandFor(settings);
  const fontUrl = fontStylesheetUrl([settings.typography.bodyFont, settings.typography.headingFont]);
  const tok = t.previewToken ?? undefined;
  // A white-label agency's logo is served per host (no id guessing); the platform theme keeps its own asset route.
  const logoSrc = (name: "logo-light" | "logo-dark", id: number) => (t.tenantId ? tenantAssetUrl("logo-light", id) : assetUrl(name, id, tok));
  // The public site can be fixed to light in Site appearance; the staff console keeps following the device.
  const fixedLight = !admin && settings.layout.colourMode === "light";
  const light = settings.brand.logoLight ?? settings.brand.logoDark;
  const dark = settings.brand.logoDark ?? settings.brand.logoLight;
  const logo = light && dark ? (
    <picture>
      {!fixedLight && <source media="(prefers-color-scheme: dark)" srcSet={logoSrc("logo-dark", dark)} />}
      <img className="brand-logo" src={logoSrc("logo-light", light)} alt={admin ? "" : brand.name} />
    </picture>
  ) : null;
  const footer = settings.footer;
  const bridgeOrigin = t.source === "draft" ? appOriginFor(admin ? "admin" : "all") : null;
  const [guide, personaId] = admin ? [null, null] : await Promise.all([getLiveGuide(), getLivePersona()]);
  const persona = personaById(personaId);

  // The saved language (set on /settings) drives <html lang> and text direction. Page text stays English until a language is enabled.
  const savedLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = !admin && savedLocale && LOCALES.some(l => l.code === savedLocale) ? savedLocale : DEFAULT_LOCALE;
  return (
    <html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"} data-theme-mode={fixedLight ? "light" : undefined} suppressHydrationWarning>
      <head>
        {!admin && !fixedLight && <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />}
        {fontUrl && <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />}
        {fontUrl && <link id="site-theme-font" rel="stylesheet" href={fontUrl} />}
        <style id="site-theme" dangerouslySetInnerHTML={{ __html: buildThemeCss(settings, { followDevice: admin }) }} />
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
                <SiteNav items={settings.navigation} iconStyle={settings.layout.iconStyle} themeToggle={!fixedLight} />
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
              <div className="site-footer-base">
                <p>{footer.text || `© ${new Date().getFullYear()} ${brand.name}`}</p>
                <nav aria-label="Legal" className="site-footer-legal">
                  <ul>{LEGAL_LINKS.map(l => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
                </nav>
              </div>
            </footer>
          </>
        )}
        <NavMemory />
        {!admin && <PwaRegister />}
        <ElenaContextTracker />
        {guide?.enabled && <GuideAssistant greeting={guide.greeting} chips={guide.chips} disclaimer={GUIDE_DISCLAIMER} persona={{ name: persona.name, icon: persona.icon, portrait: persona.portrait, poses: persona.poses }} />}
        {bridgeOrigin && <ThemePreviewBridge allowedOrigin={bridgeOrigin} />}
      </body>
    </html>
  );
}
