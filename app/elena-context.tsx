"use client";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { isListingForm, LISTING_SECTIONS, pageLabel, sectionOfField, type ElenaPlace } from "../src/domain/elena-context";

/**
 * Where the person is, for Elena: the page and the section they last clicked or typed in.
 * PRIVACY: kept in memory in this tab only. Nothing is sent to the server or stored.
 */
const EMPTY: ElenaPlace = { path: "/", pageLabel: "", section: "", sectionLabel: "", field: "" };
let place: ElenaPlace = EMPTY;
const listeners = new Set<() => void>();
export const ELENA_CONTEXT_EVENT = "ol:elena-context";

function set(next: ElenaPlace) {
  if (next.path === place.path && next.section === place.section && next.field === place.field) return;
  place = next;
  listeners.forEach(l => l());
  window.dispatchEvent(new CustomEvent(ELENA_CONTEXT_EVENT, { detail: place }));
}

export function useElenaContext(): ElenaPlace {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => place, () => EMPTY);
}

const OWN = ".ela-assist, .ga-panel, .ga-launcher, .ga-nudge";

/** Works out the section of the element the person touched. The listing form has named sections; other pages use the nearest labelled region. */
function sectionOf(el: Element, path: string): { id: string; label: string; field: string } | null {
  if (el.closest(OWN)) return null;
  const name = el.closest("[name]")?.getAttribute("name") ?? "";
  if (isListingForm(path)) {
    const s = sectionOfField(name);
    if (s) return { id: s, label: LISTING_SECTIONS[s], field: name };
    if (el.closest(".gl-mgr")) return { id: "photos", label: LISTING_SECTIONS.photos, field: "" };
  }
  const marked = el.closest("[data-elena-section]");
  if (marked) { const id = marked.getAttribute("data-elena-section")!; return { id, label: marked.getAttribute("data-elena-label") ?? id, field: name }; }
  const region = el.closest("section[aria-label], [role=region][aria-label], fieldset");
  const label = region?.getAttribute("aria-label") ?? region?.querySelector("legend, h2, h3")?.textContent?.trim() ?? "";
  return label ? { id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40), label: label.slice(0, 60), field: name } : null;
}

/** Mount once in the layout. Follows the route and the last field or section the person touched. */
export function ElenaContextTracker() {
  const path = usePathname();
  useEffect(() => { set({ path, pageLabel: pageLabel(path), section: "", sectionLabel: "", field: "" }); }, [path]);
  useEffect(() => {
    const touch = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      const s = sectionOf(e.target, window.location.pathname);
      if (s) set({ path: window.location.pathname, pageLabel: pageLabel(window.location.pathname), section: s.id, sectionLabel: s.label, field: s.field });
    };
    document.addEventListener("focusin", touch);
    document.addEventListener("click", touch);
    return () => { document.removeEventListener("focusin", touch); document.removeEventListener("click", touch); };
  }, []);
  return null;
}
