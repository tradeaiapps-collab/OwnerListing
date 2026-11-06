"use client";
import { useCallback, useEffect, useState } from "react";
import { MAX_COMPARE } from "../../src/domain/listing-compare";

export interface CompareItem { id: string; title: string }
const KEY = "ol:compare";
const EVENT = "ol:compare-changed";

/** Reads the picked listings. Anything unreadable (storage blocked, edited by hand) is an empty list. */
export function readCompare(): CompareItem[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.flatMap((x): CompareItem[] => (x && typeof x.id === "string" && typeof x.title === "string" ? [{ id: x.id, title: x.title.slice(0, 120) }] : [])).slice(0, MAX_COMPARE);
  } catch { return []; }
}
function write(items: CompareItem[]) {
  try { window.localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* picks then last for this page only */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The listings picked for comparison, kept in this browser and shared by every tab and component. */
export function useCompare() {
  const [items, setItems] = useState<CompareItem[]>([]);
  useEffect(() => {
    const sync = () => setItems(readCompare());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  const toggle = useCallback((item: CompareItem) => {
    const now = readCompare();
    write(now.some(x => x.id === item.id) ? now.filter(x => x.id !== item.id) : now.length >= MAX_COMPARE ? now : [...now, item]);
  }, []);
  const remove = useCallback((id: string) => write(readCompare().filter(x => x.id !== id)), []);
  const clear = useCallback(() => write([]), []);
  /** Replaces the picks (a shared link opened on the compare page). */
  const replace = useCallback((next: CompareItem[]) => write(next.slice(0, MAX_COMPARE)), []);
  return { items, toggle, remove, clear, replace, full: items.length >= MAX_COMPARE };
}
