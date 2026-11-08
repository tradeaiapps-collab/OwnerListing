/**
 * Admin-controlled site appearance: the settings shape, built-in defaults, strict validation and the CSS generator.
 * Pure functions (no framework, no database), safe to run in the browser editor too.
 *
 * Nothing here accepts raw CSS, HTML or script. Colours are 6-digit hex, numbers are range-checked integers, fonts and navigation ids
 * come from fixed allow-lists, links are https or same-origin paths, free text is plain text. The CSS is generated from those values only.
 */

export const HEX_RE = /^#[0-9a-f]{6}$/;

// ---- Fonts (allow-list). `google` is the family spec for the one allow-listed stylesheet host; system stacks need no download. ----
export interface FontDef { id: string; label: string; stack: string; google?: string }
export const FONTS: readonly FontDef[] = [
  { id: "system", label: "System UI (default)", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "helvetica", label: "Helvetica / Arial", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { id: "trebuchet", label: "Trebuchet", stack: '"Trebuchet MS", "Lucida Grande", sans-serif' },
  { id: "georgia", label: "Georgia (serif)", stack: 'Georgia, "Times New Roman", serif' },
  { id: "times", label: "Times (serif)", stack: '"Times New Roman", Times, serif' },
  { id: "mono", label: "Monospace", stack: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace' },
  { id: "inter", label: "Inter (web font)", stack: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', google: "Inter:wght@400;600;700" },
  { id: "roboto", label: "Roboto (web font)", stack: 'Roboto, system-ui, "Segoe UI", sans-serif', google: "Roboto:wght@400;500;700" },
  { id: "open-sans", label: "Open Sans (web font)", stack: '"Open Sans", system-ui, "Segoe UI", sans-serif', google: "Open+Sans:wght@400;600;700" },
  { id: "lato", label: "Lato (web font)", stack: 'Lato, system-ui, "Segoe UI", sans-serif', google: "Lato:wght@400;700" },
  { id: "nunito", label: "Nunito (web font)", stack: 'Nunito, system-ui, "Segoe UI", sans-serif', google: "Nunito:wght@400;600;700" },
  { id: "poppins", label: "Poppins (web font)", stack: 'Poppins, system-ui, "Segoe UI", sans-serif', google: "Poppins:wght@400;600;700" },
  { id: "merriweather", label: "Merriweather (web font, serif)", stack: 'Merriweather, Georgia, "Times New Roman", serif', google: "Merriweather:wght@400;700" },
  { id: "playfair", label: "Playfair Display (web font, serif)", stack: '"Playfair Display", Georgia, "Times New Roman", serif', google: "Playfair+Display:wght@400;600;700" }
];
const FONT_BY_ID = new Map(FONTS.map(f => [f.id, f]));
export const FONT_IDS: readonly string[] = FONTS.map(f => f.id);

/** The only stylesheet URL the site ever loads for fonts, built from the allow-list above (never from stored text). Null when no web font is used. */
export function fontStylesheetUrl(fontIds: readonly string[]): string | null {
  const fams = [...new Set(fontIds.map(id => FONT_BY_ID.get(id)?.google).filter((g): g is string => typeof g === "string"))];
  return fams.length === 0 ? null : `https://fonts.googleapis.com/css2?${fams.map(f => `family=${f}`).join("&")}&display=swap`;
}

// ---- Navigation catalogue: ids, targets and icons are fixed in code; the admin edits label, visibility and order only. ----
export type IconName = "search" | "tag" | "plus" | "home" | "inbox" | "bookmark" | "heart" | "shield" | "gauge" | "briefcase" | "building" | "login";
export interface NavDef { id: string; label: string; href: string; icon: IconName }
export const NAV_CATALOG: readonly NavDef[] = [
  { id: "browse", label: "Browse", href: "/listings", icon: "search" },
  { id: "plans", label: "Plans", href: "/plans", icon: "tag" },
  { id: "list", label: "List a property", href: "/listings/new", icon: "plus" },
  { id: "projects", label: "Projects", href: "/investments", icon: "building" },
  { id: "mine", label: "My listings", href: "/listings/mine", icon: "home" },
  { id: "offers", label: "Offers", href: "/listings/mine", icon: "inbox" },
  { id: "searches", label: "Saved searches", href: "/buyer/saved-searches", icon: "bookmark" },
  { id: "saved", label: "Saved homes", href: "/buyer/saved-listings", icon: "heart" },
  { id: "prequal", label: "Pre-approval", href: "/buyer/prequalification", icon: "shield" },
  { id: "verification", label: "Verification", href: "/buyer/verification", icon: "shield" },
  { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: "gauge" },
  { id: "staff", label: "Staff", href: "/staff", icon: "briefcase" },
  { id: "signin", label: "Sign in", href: "/login", icon: "login" }
];
const NAV_IDS = NAV_CATALOG.map(n => n.id);

// ---- Settings shape ----
export interface ModeColours {
  primary: string; secondary: string; accent: string;
  headerBg: string; headerText: string; link: string; buttonBg: string; buttonText: string;
  bg: string; surface: string; text: string; heading: string; muted: string; border: string;
}
export type ColourKey = keyof ModeColours;
export const COLOUR_KEYS: readonly ColourKey[] = ["primary", "secondary", "accent", "headerBg", "headerText", "link", "buttonBg", "buttonText", "bg", "surface", "text", "heading", "muted", "border"];

export type Density = "compact" | "comfortable" | "spacious";
export type ButtonSize = "small" | "medium" | "large";
export type IconStyle = "outline" | "solid";
/** light: the public site is always light. system: it follows the visitor's device setting (light or dark). */
export type ColourMode = "light" | "system";
export const DENSITIES: readonly Density[] = ["compact", "comfortable", "spacious"];
export const BUTTON_SIZES: readonly ButtonSize[] = ["small", "medium", "large"];
export const ICON_STYLES: readonly IconStyle[] = ["outline", "solid"];
export const COLOUR_MODES: readonly ColourMode[] = ["light", "system"];

export interface NavItem { id: string; label: string; visible: boolean }
export interface FooterLink { label: string; href: string }

export interface ThemeSettings {
  /** hero: uploaded home hero photo id (null = the built-in illustrated background). */
  brand: { siteName: string | null; tagline: string | null; logoLight: number | null; logoDark: number | null; favicon: number | null; hero: number | null };
  colours: { light: ModeColours; dark: ModeColours };
  typography: { bodyFont: string; headingFont: string; baseSize: number; headingScale: number };
  /** heroOverlay: darkness of the overlay on the hero photo in percent (a floor keeps white text readable). heroFocus: horizontal crop point in percent (mobile). */
  layout: { density: Density; radius: number; headerHeight: number; logoHeight: number; buttonSize: ButtonSize; iconStyle: IconStyle; heroOverlay: number; heroFocus: number; colourMode: ColourMode };
  navigation: NavItem[];
  footer: { text: string; links: FooterLink[] };
}

export const DEFAULT_THEME: ThemeSettings = {
  brand: { siteName: null, tagline: null, logoLight: null, logoDark: null, favicon: null, hero: null },
  // Premium default (Oct 2026 redesign): ivory and deep navy with a champagne-gold accent; Playfair Display headings over Inter.
  colours: {
    light: {
      primary: "#9a7536", secondary: "#14213d", accent: "#9a7536",
      headerBg: "#fbfaf7", headerText: "#14213d", link: "#7a5a24", buttonBg: "#14213d", buttonText: "#fbfaf7",
      bg: "#fbfaf7", surface: "#f3efe7", text: "#1c1f26", heading: "#0f1a30", muted: "#5d6271", border: "#e2dccf"
    },
    dark: {
      primary: "#d4b37a", secondary: "#ece6da", accent: "#d4b37a",
      headerBg: "#0b1020", headerText: "#ece6da", link: "#dcc08e", buttonBg: "#d4b37a", buttonText: "#0b1020",
      bg: "#0b1020", surface: "#121a2e", text: "#e7e2d8", heading: "#f6f1e7", muted: "#a6abb8", border: "#26304a"
    }
  },
  typography: { bodyFont: "inter", headingFont: "playfair", baseSize: 16, headingScale: 1 },
  layout: { density: "comfortable", radius: 14, headerHeight: 72, logoHeight: 28, buttonSize: "medium", iconStyle: "outline", heroOverlay: 55, heroFocus: 50, colourMode: "light" },
  navigation: NAV_CATALOG.map(n => ({ id: n.id, label: n.label, visible: true })),
  footer: { text: "", links: [] }
};

// ---- Ranges (numbers outside are rejected, never silently clipped) ----
export const RANGES = {
  baseSize: [14, 20], headingScale: [1, 1.6], radius: [0, 24], headerHeight: [48, 120], logoHeight: [16, 96], heroOverlay: [45, 85], heroFocus: [0, 100]
} as const;
export const LIMITS = { siteName: 60, tagline: 120, navLabel: 30, footerText: 200, footerLinkLabel: 30, footerLinks: 6, urlLength: 300 } as const;

// ---- Contrast (WCAG 2.x) ----
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** [foreground, background, minimum ratio]. 4.5 is WCAG AA for text; 3 is AA for non-text (focus ring, accent). */
const PAIRS: readonly (readonly [ColourKey, ColourKey, number])[] = [
  ["text", "bg", 4.5], ["text", "surface", 4.5], ["heading", "bg", 4.5], ["heading", "surface", 4.5],
  ["muted", "bg", 4.5], ["muted", "surface", 4.5], ["link", "bg", 4.5], ["link", "surface", 4.5],
  ["secondary", "bg", 4.5], ["headerText", "headerBg", 4.5], ["buttonText", "buttonBg", 4.5],
  ["primary", "bg", 3], ["accent", "bg", 3]
];
const LABEL: Record<ColourKey, string> = {
  primary: "primary", secondary: "secondary", accent: "accent", headerBg: "header background", headerText: "header text", link: "link", buttonBg: "button background",
  buttonText: "button text", bg: "page background", surface: "surface", text: "text", heading: "heading", muted: "muted text", border: "border"
};

// ---- Validation ----
export type ThemeErrors = Record<string, string>;
export type ThemeResult = { ok: true; value: ThemeSettings } | { ok: false; errors: ThemeErrors };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const PLAIN = /^[^\u0000-\u001f\u007f<>{}`]*$/;
const URL_CHARS = /^[^\s<>"'`\\\u0000-\u001f\u007f]+$/;

function checkKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, errors: ThemeErrors): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors[path ? `${path}.${k.slice(0, 40)}` : k.slice(0, 40)] = "Unknown setting.";
  for (const k of allowed) if (!(k in o)) errors[path ? `${path}.${k}` : k] = "Missing.";
}

function plainText(v: unknown, max: number, path: string, errors: ThemeErrors, opts: { nullable?: boolean; allowEmpty?: boolean } = {}): string | null {
  if (v === null && opts.nullable) return null;
  if (typeof v !== "string") { errors[path] = "Must be text."; return null; }
  const t = v.trim();
  if (t.length === 0) {
    if (opts.nullable) return null;
    if (!opts.allowEmpty) errors[path] = "Required.";
    return "";
  }
  if (t.length > max) { errors[path] = `At most ${max} characters.`; return null; }
  if (!PLAIN.test(t)) { errors[path] = "Plain text only: no HTML, braces or control characters."; return null; }
  return t;
}

function num(v: unknown, [min, max]: readonly [number, number], path: string, errors: ThemeErrors, integer: boolean): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) { errors[path] = "Must be a number."; return null; }
  if (integer && !Number.isInteger(v)) { errors[path] = "Must be a whole number."; return null; }
  if (v < min || v > max) { errors[path] = `Must be between ${min} and ${max}.`; return null; }
  return integer ? v : Math.round(v * 100) / 100;
}

/** https URL or same-origin path. No other scheme, no credentials, no whitespace, quotes or angle brackets. */
export function safeLink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > LIMITS.urlLength || !URL_CHARS.test(s)) return null;
  if (s.startsWith("/")) return s.startsWith("//") ? null : s;
  if (!/^https:\/\/[a-z0-9]/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.length > 0 && u.username === "" && u.password === "" ? s : null;
  } catch {
    return null;
  }
}

function assetId(v: unknown, path: string, errors: ThemeErrors): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) { errors[path] = "Must be an uploaded image or empty."; return null; }
  return v;
}

function modeColours(v: unknown, path: string, errors: ThemeErrors): ModeColours | null {
  if (!isObj(v)) { errors[path] = "Missing."; return null; }
  checkKeys(v, COLOUR_KEYS, path, errors);
  const out = {} as Record<ColourKey, string>;
  let ok = true;
  for (const k of COLOUR_KEYS) {
    const raw = v[k];
    const hex = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!HEX_RE.test(hex)) { errors[`${path}.${k}`] = "Use a 6-digit hex colour such as #0b5fd6."; ok = false; } else out[k] = hex;
  }
  if (!ok) return null;
  for (const [fg, bg, min] of PAIRS) {
    const r = contrastRatio(out[fg], out[bg]);
    if (r < min && !errors[`${path}.${fg}`]) errors[`${path}.${fg}`] = `Contrast of ${LABEL[fg]} on ${LABEL[bg]} is ${r.toFixed(2)}:1; at least ${min}:1 is required (WCAG AA).`;
  }
  return out;
}

/** Strict validation of a whole settings object. Unknown keys are errors; every field is required. Returns a normalised copy. */
export function validateTheme(input: unknown): ThemeResult {
  const errors: ThemeErrors = {};
  if (!isObj(input)) return { ok: false, errors: { "": "Send a settings object." } };
  checkKeys(input, ["brand", "colours", "typography", "layout", "navigation", "footer"], "", errors);

  const b = input["brand"];
  let brand: ThemeSettings["brand"] | null = null;
  if (isObj(b)) {
    checkKeys(b, ["siteName", "tagline", "logoLight", "logoDark", "favicon", "hero"], "brand", errors);
    brand = {
      siteName: plainText(b["siteName"], LIMITS.siteName, "brand.siteName", errors, { nullable: true }),
      tagline: plainText(b["tagline"], LIMITS.tagline, "brand.tagline", errors, { nullable: true }),
      logoLight: assetId(b["logoLight"], "brand.logoLight", errors),
      logoDark: assetId(b["logoDark"], "brand.logoDark", errors),
      favicon: assetId(b["favicon"], "brand.favicon", errors),
      hero: assetId(b["hero"], "brand.hero", errors)
    };
  } else errors["brand"] = "Missing.";

  const c = input["colours"];
  let colours: ThemeSettings["colours"] | null = null;
  if (isObj(c)) {
    checkKeys(c, ["light", "dark"], "colours", errors);
    const light = modeColours(c["light"], "colours.light", errors);
    const dark = modeColours(c["dark"], "colours.dark", errors);
    if (light && dark) colours = { light, dark };
  } else errors["colours"] = "Missing.";

  const t = input["typography"];
  let typography: ThemeSettings["typography"] | null = null;
  if (isObj(t)) {
    checkKeys(t, ["bodyFont", "headingFont", "baseSize", "headingScale"], "typography", errors);
    const font = (k: string) => {
      const v = t[k];
      if (typeof v !== "string" || !FONT_BY_ID.has(v)) { errors[`typography.${k}`] = "Choose a font from the list."; return null; }
      return v;
    };
    const bodyFont = font("bodyFont"), headingFont = font("headingFont");
    const baseSize = num(t["baseSize"], RANGES.baseSize, "typography.baseSize", errors, true);
    const headingScale = num(t["headingScale"], RANGES.headingScale, "typography.headingScale", errors, false);
    if (bodyFont && headingFont && baseSize !== null && headingScale !== null) typography = { bodyFont, headingFont, baseSize, headingScale };
  } else errors["typography"] = "Missing.";

  const l = input["layout"];
  let layout: ThemeSettings["layout"] | null = null;
  if (isObj(l)) {
    checkKeys(l, ["density", "radius", "headerHeight", "logoHeight", "buttonSize", "iconStyle", "heroOverlay", "heroFocus", "colourMode"], "layout", errors);
    const pick = <T extends string>(k: string, list: readonly T[]): T | null => {
      const v = l[k];
      if (typeof v !== "string" || !(list as readonly string[]).includes(v)) { errors[`layout.${k}`] = `Choose one of: ${list.join(", ")}.`; return null; }
      return v as T;
    };
    const density = pick("density", DENSITIES), buttonSize = pick("buttonSize", BUTTON_SIZES), iconStyle = pick("iconStyle", ICON_STYLES), colourMode = pick("colourMode", COLOUR_MODES);
    const radius = num(l["radius"], RANGES.radius, "layout.radius", errors, true);
    const headerHeight = num(l["headerHeight"], RANGES.headerHeight, "layout.headerHeight", errors, true);
    const logoHeight = num(l["logoHeight"], RANGES.logoHeight, "layout.logoHeight", errors, true);
    const heroOverlay = num(l["heroOverlay"], RANGES.heroOverlay, "layout.heroOverlay", errors, true);
    const heroFocus = num(l["heroFocus"], RANGES.heroFocus, "layout.heroFocus", errors, true);
    if (density && buttonSize && iconStyle && colourMode && radius !== null && headerHeight !== null && logoHeight !== null && heroOverlay !== null && heroFocus !== null) {
      layout = { density, radius, headerHeight, logoHeight, buttonSize, iconStyle, heroOverlay, heroFocus, colourMode };
    }
  } else errors["layout"] = "Missing.";

  const n = input["navigation"];
  let navigation: NavItem[] | null = null;
  if (Array.isArray(n)) {
    const items: NavItem[] = [];
    const seen = new Set<string>();
    let good = n.length === NAV_IDS.length;
    if (!good) errors["navigation"] = "Every navigation item must be listed once (hide an item instead of removing it).";
    n.slice(0, NAV_IDS.length + 1).forEach((it, i) => {
      const p = `navigation.${i}`;
      if (!isObj(it)) { errors[p] = "Invalid item."; good = false; return; }
      checkKeys(it, ["id", "label", "visible"], p, errors);
      const id = it["id"];
      if (typeof id !== "string" || !NAV_IDS.includes(id) || seen.has(id)) { errors[`${p}.id`] = "Unknown or repeated item."; good = false; return; }
      seen.add(id);
      const label = plainText(it["label"], LIMITS.navLabel, `${p}.label`, errors);
      if (typeof it["visible"] !== "boolean") { errors[`${p}.visible`] = "Must be true or false."; good = false; }
      if (label === null || typeof it["visible"] !== "boolean") { good = false; return; }
      items.push({ id, label, visible: it["visible"] });
    });
    if (good && items.length === NAV_IDS.length) navigation = items;
  } else errors["navigation"] = "Missing.";

  const f = input["footer"];
  let footer: ThemeSettings["footer"] | null = null;
  if (isObj(f)) {
    checkKeys(f, ["text", "links"], "footer", errors);
    const text = plainText(f["text"], LIMITS.footerText, "footer.text", errors, { allowEmpty: true });
    const links: FooterLink[] = [];
    let good = text !== null;
    if (!Array.isArray(f["links"])) { errors["footer.links"] = "Must be a list."; good = false; }
    else if (f["links"].length > LIMITS.footerLinks) { errors["footer.links"] = `At most ${LIMITS.footerLinks} links.`; good = false; }
    else {
      f["links"].forEach((lk, i) => {
        const p = `footer.links.${i}`;
        if (!isObj(lk)) { errors[p] = "Invalid link."; good = false; return; }
        checkKeys(lk, ["label", "href"], p, errors);
        const label = plainText(lk["label"], LIMITS.footerLinkLabel, `${p}.label`, errors);
        const href = safeLink(lk["href"]);
        if (href === null) errors[`${p}.href`] = "Use an https:// link or a path starting with / on this site.";
        if (label === null || href === null) good = false; else links.push({ label, href });
      });
    }
    if (good && text !== null) footer = { text, links };
  } else errors["footer"] = "Missing.";

  if (Object.keys(errors).length > 0 || !brand || !colours || !typography || !layout || !navigation || !footer) {
    return { ok: false, errors: Object.keys(errors).length > 0 ? errors : { "": "Invalid settings." } };
  }
  return { ok: true, value: { brand, colours, typography, layout, navigation, footer } };
}

/**
 * Settings read back from storage: anything that no longer validates falls back to the defaults. Versions saved before the hero
 * settings existed get the default hero values (only keys that are absent are filled; present values are still validated).
 */
export function parseStoredTheme(raw: unknown): ThemeSettings {
  const r = validateTheme(withNewKeys(raw));
  return r.ok ? r.value : structuredClone(DEFAULT_THEME);
}

/** Dotted paths whose value differs between two settings objects (field names only, for the audit log). */
export function changedFields(a: ThemeSettings, b: ThemeSettings): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (Array.isArray(x) || Array.isArray(y) || !isObj(x) || !isObj(y)) {
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p);
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k);
  };
  walk(a, b, "");
  return out;
}

function withNewKeys(raw: unknown): unknown {
  if (!isObj(raw) || !isObj(raw["brand"]) || !isObj(raw["layout"])) return raw;
  // Saved themes that predate a navigation item get it added (visible, default label) so they still validate.
  const saved = Array.isArray(raw["navigation"]) ? raw["navigation"] : null;
  const navigation = saved === null ? raw["navigation"] : [
    ...saved,
    ...NAV_CATALOG.filter(d => !saved.some(it => isObj(it) && it["id"] === d.id)).map(d => ({ id: d.id, label: d.label, visible: true }))
  ];
  return {
    ...raw,
    navigation,
    brand: { hero: DEFAULT_THEME.brand.hero, ...raw["brand"] },
    layout: { heroOverlay: DEFAULT_THEME.layout.heroOverlay, heroFocus: DEFAULT_THEME.layout.heroFocus, colourMode: DEFAULT_THEME.layout.colourMode, ...raw["layout"] }
  };
}

// ---- CSS generation ----
const SPACE_BASE = [4, 8, 12, 16, 24, 32] as const;
const DENSITY_FACTOR: Record<Density, number> = { compact: 0.75, comfortable: 1, spacious: 1.35 };
const BUTTON: Record<ButtonSize, { h: number; px: number; fs: string }> = {
  small: { h: 40, px: 12, fs: "0.9rem" }, medium: { h: 46, px: 22, fs: "0.9375rem" }, large: { h: 52, px: 24, fs: "1.125rem" }
};

function colourVars(c: ModeColours): string {
  return `--bg:${c.bg};--surface:${c.surface};--text:${c.text};--heading:${c.heading};--muted:${c.muted};--border:${c.border};` +
    `--brand:${c.buttonBg};--brand-text:${c.buttonText};--focus:${c.primary};--primary:${c.primary};--secondary:${c.secondary};--accent:${c.accent};` +
    `--link:${c.link};--header-bg:${c.headerBg};--header-text:${c.headerText};`;
}

/**
 * CSS custom properties for a settings object. Every value is re-checked against the same rules as validateTheme, and any
 * object that does not pass is replaced by the defaults, so even a corrupted database row cannot put text into the stylesheet.
 */
export function buildThemeCss(settings: ThemeSettings, opts: { followDevice?: boolean } = {}): string {
  const checked = validateTheme(settings);
  const t = checked.ok ? checked.value : DEFAULT_THEME; // the normalised copy (trimmed, lower-case hex), never the raw input
  const f = DENSITY_FACTOR[t.layout.density];
  const body = FONT_BY_ID.get(t.typography.bodyFont)!, head = FONT_BY_ID.get(t.typography.headingFont)!;
  const btn = BUTTON[t.layout.buttonSize];
  const shared =
    SPACE_BASE.map((b, i) => `--space-${[1, 2, 3, 4, 6, 8][i]}:${Math.round(b * f)}px;`).join("") +
    `--radius:${t.layout.radius}px;--radius-sm:${Math.round(t.layout.radius * 0.8)}px;` +
    `--font-body:${body.stack};--font-heading:${head.stack};--fs:${t.typography.baseSize}px;--hs:${t.typography.headingScale};` +
    `--header-h:${t.layout.headerHeight}px;--logo-h:${t.layout.logoHeight}px;--btn-h:${btn.h}px;--btn-px:${btn.px}px;--btn-fs:${btn.fs};` +
    `--hero-overlay:${t.layout.heroOverlay / 100};--hero-focus:${t.layout.heroFocus}%;`;
  const light = colourVars(t.colours.light), dark = colourVars(t.colours.dark);
  const css =
    `:root:root{${shared}${light}}` +
    (t.layout.colourMode === "system" || opts.followDevice ? `@media (prefers-color-scheme: dark){:root:root{${dark}}}` : "") +
    `:root:root[data-theme-mode="light"]{color-scheme:light;${light}}` +
    `:root:root[data-theme-mode="dark"]{color-scheme:dark;${dark}}`;
  return css.replace(/</g, "");
}

export const assetUrl = (name: "logo-light" | "logo-dark" | "favicon" | "hero", id: number, previewToken?: string): string =>
  `/api/site/asset/${name}?v=${id}${previewToken ? `&theme_preview=${encodeURIComponent(previewToken)}` : ""}`;
