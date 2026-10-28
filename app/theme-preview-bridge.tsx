"use client";
import { useEffect } from "react";
import { buildThemeCss, fontStylesheetUrl, validateTheme } from "../src/domain/site-theme";

/**
 * Rendered only on a verified theme preview. Lets the staff editor (the parent window, exact origin match) push the settings it is
 * editing so the page updates as they type. Only a settings OBJECT is accepted: it is validated and the CSS is generated here from the
 * allow-listed values. Raw CSS, HTML or script sent in a message is never used.
 */
export default function ThemePreviewBridge({ allowedOrigin }: { allowedOrigin: string }) {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== allowedOrigin || e.source !== window.parent) return;
      const m = e.data as { type?: unknown; settings?: unknown; mode?: unknown } | null;
      if (!m || m.type !== "ol-theme-draft") return;
      const r = validateTheme(m.settings);
      if (!r.ok) return;
      // The editor's light/dark preview toggle wins; otherwise show the draft's colour mode (fixed light, or follow the device).
      const mode = m.mode === "light" || m.mode === "dark" ? m.mode : r.value.layout.colourMode === "light" ? "light" : null;
      if (mode) document.documentElement.dataset["themeMode"] = mode;
      else delete document.documentElement.dataset["themeMode"];
      const style = document.getElementById("site-theme");
      if (style) style.textContent = buildThemeCss(r.value);
      const url = fontStylesheetUrl([r.value.typography.bodyFont, r.value.typography.headingFont]);
      let link = document.getElementById("site-theme-font") as HTMLLinkElement | null;
      if (url && !link) {
        link = document.createElement("link");
        link.id = "site-theme-font"; link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      if (link) { if (url) link.href = url; else link.remove(); }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "ol-theme-ready" }, allowedOrigin);
    return () => window.removeEventListener("message", onMessage);
  }, [allowedOrigin]);
  return null;
}
