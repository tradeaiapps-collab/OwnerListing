"use client";
import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export const THEME_KEY = "ol-theme";
/** Runs in <head> before first paint (see layout.tsx) so a saved choice never flashes the wrong colours. Skipped when Site appearance fixes light. */
export const THEME_INIT_SCRIPT = `try{var m=localStorage.getItem("${THEME_KEY}"),d=document.documentElement;if((m==="light"||m==="dark")&&!d.hasAttribute("data-theme-mode"))d.setAttribute("data-theme-mode",m)}catch(e){}`;

const ORDER: ThemeChoice[] = ["light", "dark", "system"];
const LABEL: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "Device setting" };
const read = (): ThemeChoice => { try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; } };

/** Icon button in the site header that cycles light, dark and device setting. The server renders it only while the site follows the device. */
export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice | null>(null);
  useEffect(() => setChoice(read()), []);
  const apply = (c: ThemeChoice) => {
    const root = document.documentElement;
    if (c === "system") root.removeAttribute("data-theme-mode"); else root.setAttribute("data-theme-mode", c);
    try { if (c === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, c); } catch { /* storage blocked: the choice lasts for this page only */ }
    setChoice(c);
  };
  const cur = choice ?? "system";
  const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]!;
  return (
    <button type="button" className="theme-toggle" onClick={() => apply(next)} aria-label={`Colour theme: ${LABEL[cur]}. Switch to ${LABEL[next]}`} title={`Colour theme: ${LABEL[cur]}`}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {cur === "light" && <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
        {cur === "dark" && <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />}
        {cur === "system" && <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>}
      </svg>
    </button>
  );
}
