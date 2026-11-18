/** Installable web app (PWA) settings: the manifest and the rules for the install prompt. Pure functions, no browser access. */

export const PWA_THEME_COLOUR = "#14213d";
export const PWA_BACKGROUND_COLOUR = "#fbfaf7";
export const PWA_OFFLINE_PATH = "/offline";
/** How many days a dismissed install prompt stays hidden. */
export const INSTALL_DISMISS_DAYS = 30;

export interface ManifestInput { name: string; tagline: string }

/** Web app manifest. The shortcuts are public pages only (Browse, Projects, Plans); signed-in pages are never named here. */
export function buildManifest({ name, tagline }: ManifestInput) {
  const short = name.length <= 12 ? name : name.slice(0, 12).trim();
  return {
    id: "/",
    name,
    short_name: short,
    description: `${tagline}. List your own property, meet verified buyers and decide on every offer yourself.`,
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone" as const,
    orientation: "portrait" as const,
    theme_color: PWA_THEME_COLOUR,
    background_color: PWA_BACKGROUND_COLOUR,
    lang: "en-AU",
    categories: ["business", "lifestyle"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ],
    shortcuts: [
      { name: "Browse listings", url: "/listings?source=pwa" },
      { name: "Projects", url: "/investments?source=pwa" },
      { name: "Plans", url: "/plans?source=pwa" }
    ]
  };
}

export type InstallMode = "hidden" | "prompt" | "ios";

export interface InstallContext {
  standalone: boolean;
  /** The browser has offered an install event (Chrome, Edge, Samsung Internet on Android and desktop). */
  hasPromptEvent: boolean;
  userAgent: string;
  dismissedAt: number | null;
  now: number;
}

export const isIosSafari = (ua: string) => /iP(hone|ad|od)/.test(ua) && /Safari\//.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)\//.test(ua);

/** What to show: nothing (installed, or dismissed recently), the native prompt button, or the iPhone "Add to Home Screen" steps. */
export function installMode(c: InstallContext): InstallMode {
  if (c.standalone) return "hidden";
  if (c.dismissedAt !== null && c.now - c.dismissedAt < INSTALL_DISMISS_DAYS * 86_400_000) return "hidden";
  if (c.hasPromptEvent) return "prompt";
  return isIosSafari(c.userAgent) ? "ios" : "hidden";
}
