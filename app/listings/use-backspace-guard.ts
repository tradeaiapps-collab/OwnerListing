import { useEffect } from "react";

/** True when the key press is typing in a field, where Backspace must keep deleting text. */
export function isEditingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement) return !(t as HTMLTextAreaElement).readOnly;
  if (t instanceof HTMLInputElement) return !t.readOnly && !t.disabled && !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"].includes(t.type);
  return false;
}

/** Some browsers (Opera) treat Backspace outside a text field as Back and throw the owner off the form. Ignore it there. */
export function useBackspaceGuard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditingTarget(e.target)) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
