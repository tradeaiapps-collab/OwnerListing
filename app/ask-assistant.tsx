"use client";
import { OPEN_GUIDE_EVENT } from "./guide-assistant";

/** Opens the floating guide assistant from anywhere on the page. */
export default function AskAssistant({ name }: { name: string }) {
  return <button type="button" className="button" onClick={() => window.dispatchEvent(new Event(OPEN_GUIDE_EVENT))}>Ask {name} a question</button>;
}
